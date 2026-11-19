/**
 * Validates Microsoft Entra ID v2.0 access tokens.
 *
 * Used for the interactive agent's inbound authorization (user tokens whose
 * audience is the agent identity blueprint) and by the echo MCP server
 * (user or app tokens, optionally only from agents).
 *
 * Checks: RS256 signature against the tenant's JWKS (OIDC discovery), issuer,
 * tenant, audience, lifetime, token type, delegated scopes / app roles, and
 * optionally that the caller is an agent (xms_par_app_azp present).
 *
 * Dependency-free on purpose (WebCrypto + fetch), so it runs in Workers and in
 * Node tests, and needs nothing from a package feed.
 */
import { decodeJwtHeader, decodeJwtPayload, type JwtClaims } from "./claims.ts";
import { base64UrlToBytes, toArrayBuffer, utf8Encode } from "./encoding.ts";

export interface EntraTokenValidatorOptions {
  tenantId: string;
  /** Accepted `aud` values, typically [blueprintAppId, `api://${blueprintAppId}`]. */
  audiences: string[];
  /** Which token types are accepted. Default "user" (OBO needs a user token). */
  tokenTypes?: "user" | "app" | "any";
  /** Delegated scopes that must ALL be present in `scp` (user tokens). */
  requiredScopes?: string[];
  /** App roles that must ALL be present in `roles` (app tokens). */
  requiredRoles?: string[];
  /** Require `xms_par_app_azp` (the token was issued to an agent identity). */
  requireAgentCaller?: boolean;
  /** Optional allow-list for the calling client application (`azp`). */
  allowedClientIds?: string[];
  clockSkewSeconds?: number;
  authorityHost?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export interface EntraAccessToken {
  /** The raw JWT, needed as the OBO assertion. Never log it. */
  raw: string;
  claims: JwtClaims;
  kind: "user" | "app";
  /** User object ID (user tokens) or the calling service principal / agent identity (app tokens). */
  oid: string;
  tid: string;
  scopes: string[];
  roles: string[];
  clientId: string;
  displayName?: string;
}

/** Back-compat alias. */
export type EntraUserToken = EntraAccessToken;

/**
 * invalid_request / invalid_token -> 401 (RFC 6750), insufficient_scope -> 403 (RFC 6750),
 * access_denied -> 403: a valid token whose caller a policy refuses (e.g. not an agent).
 */
export type TokenErrorCode = "invalid_token" | "insufficient_scope" | "invalid_request" | "access_denied";

export class TokenValidationError extends Error {
  readonly status: 401 | 403;
  readonly code: TokenErrorCode;
  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = "TokenValidationError";
    this.code = code;
    this.status = code === "insufficient_scope" || code === "access_denied" ? 403 : 401;
  }
  /** access_denied is a policy decision, not an authentication problem: no challenge. */
  get needsChallenge(): boolean {
    return this.code !== "access_denied";
  }
  /** RFC 6750 challenge. */
  toWwwAuthenticate(): string {
    const description = this.message.replace(/"/g, "'");
    return `Bearer error="${this.code}", error_description="${description}"`;
  }
}

interface CachedKeys {
  issuer: string;
  jwksUri: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

// Shared across requests within an isolate.
const keyCache = new Map<string, CachedKeys>();
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  use?: string;
}

export class EntraTokenValidator {
  private readonly options: EntraTokenValidatorOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EntraTokenValidatorOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private get metadataUrl(): string {
    const host = this.options.authorityHost ?? "https://login.microsoftonline.com";
    return `${host}/${this.options.tenantId}/v2.0/.well-known/openid-configuration`;
  }

  private async loadKeys(forceRefresh: boolean): Promise<CachedKeys> {
    const now = Date.now();
    const cached = keyCache.get(this.metadataUrl);
    if (cached && !forceRefresh && now - cached.fetchedAt < KEY_TTL_MS) return cached;
    if (cached && forceRefresh && now - cached.fetchedAt < MIN_REFRESH_INTERVAL_MS) return cached;

    const metadataResponse = await this.fetchImpl(this.metadataUrl);
    if (!metadataResponse.ok) throw new Error(`OIDC metadata request failed: HTTP ${metadataResponse.status}`);
    const metadata = (await metadataResponse.json()) as { issuer?: string; jwks_uri?: string };
    if (!metadata.issuer || !metadata.jwks_uri) throw new Error("OIDC metadata is missing issuer or jwks_uri");

    const jwksResponse = await this.fetchImpl(metadata.jwks_uri);
    if (!jwksResponse.ok) throw new Error(`JWKS request failed: HTTP ${jwksResponse.status}`);
    const jwks = (await jwksResponse.json()) as { keys?: Jwk[] };

    const keys = new Map<string, CryptoKey>();
    for (const jwk of jwks.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      if (jwk.use && jwk.use !== "sig") continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        keys.set(jwk.kid, key);
      } catch {
        // skip keys WebCrypto cannot import
      }
    }
    const entry: CachedKeys = { issuer: metadata.issuer, jwksUri: metadata.jwks_uri, keys, fetchedAt: now };
    keyCache.set(this.metadataUrl, entry);
    return entry;
  }

  /** Validates an `Authorization` header value (or a bare token). */
  async validate(authorization: string | null | undefined): Promise<EntraAccessToken> {
    if (!authorization) throw new TokenValidationError("invalid_request", "Missing Authorization header");
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const raw = (match ? match[1] : authorization).trim();
    const parts = raw.split(".");
    if (parts.length !== 3) throw new TokenValidationError("invalid_token", "Token is not a signed JWT");

    const header = decodeJwtHeader(raw);
    const claims = decodeJwtPayload(raw);
    if (!header || !claims) throw new TokenValidationError("invalid_token", "Token header or payload is not valid JSON");
    if (header.alg !== "RS256") throw new TokenValidationError("invalid_token", `Unsupported token algorithm '${String(header.alg)}'`);
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    if (!kid) throw new TokenValidationError("invalid_token", "Token has no key id (kid)");

    // Signature
    let keys = await this.loadKeys(false);
    let key = keys.keys.get(kid);
    if (!key) {
      keys = await this.loadKeys(true); // signing keys roll over: refresh once
      key = keys.keys.get(kid);
    }
    if (!key) throw new TokenValidationError("invalid_token", "Token signing key is not published by the tenant");
    let signature: Uint8Array;
    try {
      signature = base64UrlToBytes(parts[2]);
    } catch {
      throw new TokenValidationError("invalid_token", "Token signature is malformed");
    }
    const signatureValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      toArrayBuffer(signature),
      toArrayBuffer(utf8Encode(`${parts[0]}.${parts[1]}`)),
    );
    if (!signatureValid) throw new TokenValidationError("invalid_token", "Token signature is invalid");

    // Issuer / version / tenant
    if (claims.ver !== "2.0") {
      throw new TokenValidationError(
        "invalid_token",
        "Token is not a v2.0 access token. Set api.requestedAccessTokenVersion = 2 on the agent identity blueprint.",
      );
    }
    if (claims.iss !== keys.issuer) throw new TokenValidationError("invalid_token", "Token issuer is not the expected tenant");
    if (claims.tid !== this.options.tenantId) throw new TokenValidationError("invalid_token", "Token tenant mismatch");

    // Audience
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((a) => typeof a === "string" && this.options.audiences.includes(a))) {
      throw new TokenValidationError("invalid_token", "Token audience is not this agent's blueprint");
    }

    // Lifetime
    const nowSec = Math.floor((this.options.nowMs?.() ?? Date.now()) / 1000);
    const skew = this.options.clockSkewSeconds ?? 300;
    if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) throw new TokenValidationError("invalid_token", "Token has expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > nowSec) throw new TokenValidationError("invalid_token", "Token is not valid yet");

    // Token type: delegated (scp) vs application (roles, idtyp=app).
    const scopes = typeof claims.scp === "string" ? claims.scp.split(" ").filter(Boolean) : [];
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [];
    const kind: "user" | "app" = claims.idtyp === "app" || scopes.length === 0 ? "app" : "user";
    const accepted = this.options.tokenTypes ?? "user";
    if (accepted === "user" && kind !== "user") {
      throw new TokenValidationError("insufficient_scope", "A user (delegated) token is required");
    }
    if (accepted === "app" && kind !== "app") {
      throw new TokenValidationError("insufficient_scope", "An application token is required");
    }
    if (kind === "user") {
      const missing = (this.options.requiredScopes ?? []).filter((s) => !scopes.includes(s));
      if (missing.length > 0) {
        throw new TokenValidationError("insufficient_scope", `Missing required scope(s): ${missing.join(", ")}`);
      }
    } else {
      const missing = (this.options.requiredRoles ?? []).filter((r) => !roles.includes(r));
      if (missing.length > 0) {
        throw new TokenValidationError("insufficient_scope", `Missing required app role(s): ${missing.join(", ")}`);
      }
    }
    if (this.options.requireAgentCaller && typeof claims.xms_par_app_azp !== "string") {
      throw new TokenValidationError(
        "invalid_token",
        "Only agent identities may call this API (xms_par_app_azp missing: not an agent, or the API's app registration does not list the optional claim)",
      );
    }

    const clientId = typeof claims.azp === "string" ? claims.azp : String(claims.appid ?? "");
    if (this.options.allowedClientIds?.length && !this.options.allowedClientIds.includes(clientId)) {
      throw new TokenValidationError("invalid_token", "Calling client application is not allowed");
    }
    if (typeof claims.oid !== "string") throw new TokenValidationError("invalid_token", "Token has no oid claim");

    return {
      raw,
      claims,
      kind,
      oid: claims.oid,
      tid: String(claims.tid),
      scopes,
      roles,
      clientId,
      displayName: typeof claims.name === "string" ? claims.name : undefined,
    };
  }
}

/** For tests. */
export function clearSigningKeyCache(): void {
  keyCache.clear();
}
