/**
 * Non-secret views of JWTs for diagnostics.
 *
 * Tokens themselves are never logged, returned to callers, or given to the LLM.
 * These helpers decode the payload WITHOUT validating it, so use them only to
 * describe tokens this service obtained itself or already validated.
 */
import { base64UrlToBytes, utf8Decode } from "./encoding.ts";

export type JwtClaims = Record<string, unknown>;

export function decodeJwtPayload(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const claims = JSON.parse(utf8Decode(base64UrlToBytes(parts[1])));
    return claims && typeof claims === "object" ? (claims as JwtClaims) : undefined;
  } catch {
    return undefined;
  }
}

export function decodeJwtHeader(token: string): JwtClaims | undefined {
  const [header] = token.split(".");
  try {
    return JSON.parse(utf8Decode(base64UrlToBytes(header))) as JwtClaims;
  } catch {
    return undefined;
  }
}

/** Claims worth showing when explaining "who is calling whom". */
const SUMMARY_CLAIMS = [
  "aud",
  "iss",
  "tid",
  "ver",
  "idtyp",
  "azp",
  "appid",
  "oid",
  "sub",
  "upn",
  "preferred_username",
  "name",
  "scp",
  "roles",
  "iat",
  "exp",
] as const;

export interface TokenSummary {
  [claim: string]: unknown;
}

/**
 * Picks routing/identity claims plus every `xms_*` claim (Entra puts the agent
 * facets there, e.g. which object is the actor and which is the subject).
 */
export function summarizeToken(token: string): TokenSummary | undefined {
  const claims = decodeJwtPayload(token);
  if (!claims) return undefined;
  const summary: TokenSummary = {};
  for (const name of SUMMARY_CLAIMS) {
    if (claims[name] !== undefined) summary[name] = claims[name];
  }
  for (const [name, value] of Object.entries(claims)) {
    if (name.startsWith("xms_")) summary[name] = value;
  }
  if (typeof claims.exp === "number") summary.expiresAt = new Date(claims.exp * 1000).toISOString();
  return summary;
}
