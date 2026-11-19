/**
 * Cloudflare API Shield JWT validation for Microsoft Entra tokens: the edge
 * "authorizer", the closest Cloudflare counterpart of an AWS API Gateway /
 * AgentCore JWT authorizer. Requests without a valid Entra token for the API
 * are stopped before the Worker runs. Enterprise plan with API Shield only.
 *
 * What the edge checks (token configuration): signature against the keys we
 * upload, exp and nbf (60 s tolerance). What our WAF custom rule adds: issuer,
 * audience and, optionally, the agent's blueprint (xms_par_app_azp). The
 * Worker still validates everything itself (defence in depth; service-binding
 * and same-zone calls do not pass through the edge).
 *
 * API Shield does not fetch JWKS URLs, so keys are pushed: by the setup script
 * and on a schedule by the edge-jwks-sync Worker.
 *
 * Dependency-free; used by scripts/cloudflare/setup-edge-jwt-validation.mjs,
 * src/edge-jwks-sync and the tests.
 */

export interface ApiShieldJwk {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
}

export interface CloudflareApiOptions {
  apiToken: string;
  /** Default https://api.cloudflare.com/client/v4 */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: unknown[];
  constructor(message: string, status: number, errors: unknown[] = []) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

/** Where API Shield looks for the token: the Authorization header ("Bearer <jwt>" is accepted). */
export const TOKEN_SOURCE = 'http.request.headers["authorization"][0]';
/** API Shield limit per token configuration. */
export const MAX_KEYS = 16;
export const CUSTOM_RULES_PHASE = "http_request_firewall_custom";

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function cf<T>(opts: CloudflareApiOptions, method: string, path: string, body?: unknown): Promise<{ status: number; result?: T }> {
  const base = (opts.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let envelope: Envelope<T> = {};
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    // non-JSON error page
  }
  if (response.status === 404 && method === "GET") return { status: 404 };
  if (!response.ok || envelope.success === false) {
    const details = (envelope.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
    throw new CloudflareApiError(`${method} ${path} failed: HTTP ${response.status}${details ? ` (${details})` : ""}`, response.status, envelope.errors);
  }
  return { status: response.status, result: envelope.result };
}

/** The tenant's token signing keys, shaped for API Shield (alg set explicitly, extra fields dropped). */
export async function entraSigningKeys(tenantId: string, authorityHost = "https://login.microsoftonline.com", fetchImpl?: typeof fetch): Promise<ApiShieldJwk[]> {
  const doFetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const host = authorityHost.replace(/\/+$/, "");
  const metadataResponse = await doFetch(`${host}/${tenantId}/v2.0/.well-known/openid-configuration`);
  if (!metadataResponse.ok) throw new Error(`Entra OIDC metadata: HTTP ${metadataResponse.status}`);
  const { jwks_uri: jwksUri } = (await metadataResponse.json()) as { jwks_uri?: string };
  if (!jwksUri) throw new Error("Entra OIDC metadata has no jwks_uri");
  const jwksResponse = await doFetch(jwksUri);
  if (!jwksResponse.ok) throw new Error(`Entra JWKS: HTTP ${jwksResponse.status}`);
  const { keys = [] } = (await jwksResponse.json()) as { keys?: Record<string, unknown>[] };
  const usable = keys
    .filter((k) => k.kty === "RSA" && typeof k.kid === "string" && typeof k.n === "string" && typeof k.e === "string" && (k.use === undefined || k.use === "sig"))
    .map((k): ApiShieldJwk => ({ kty: "RSA", kid: k.kid as string, n: k.n as string, e: k.e as string, alg: "RS256", use: "sig" }));
  if (!usable.length) throw new Error("Entra JWKS contains no usable RSA signing keys");
  return usable.slice(0, MAX_KEYS);
}

interface TokenConfiguration {
  id: string;
  title?: string;
}

/** Creates the token configuration, or replaces the keys of the one with the same title. */
export async function ensureTokenConfiguration(
  opts: CloudflareApiOptions,
  zoneId: string,
  title: string,
  description: string,
  keys: ApiShieldJwk[],
): Promise<{ id: string; created: boolean }> {
  const list = await cf<TokenConfiguration[]>(opts, "GET", `/zones/${zoneId}/token_validation/config?per_page=50`);
  const existing = (list.result ?? []).find((c) => c.title === title);
  if (existing) {
    await updateTokenConfigurationKeys(opts, zoneId, existing.id, keys);
    return { id: existing.id, created: false };
  }
  const created = await cf<TokenConfiguration>(opts, "POST", `/zones/${zoneId}/token_validation/config`, {
    title: title.slice(0, 50),
    description: description.slice(0, 500),
    token_sources: [TOKEN_SOURCE],
    token_type: "jwt",
    credentials: { keys },
  });
  if (!created.result?.id) throw new CloudflareApiError("Token configuration was created but no ID was returned", created.status);
  return { id: created.result.id, created: true };
}

/** PUT replaces the complete key set (keys that Entra no longer publishes are removed). */
export async function updateTokenConfigurationKeys(opts: CloudflareApiOptions, zoneId: string, configId: string, keys: ApiShieldJwk[]): Promise<void> {
  await cf(opts, "PUT", `/zones/${zoneId}/token_validation/config/${configId}/credentials`, { keys });
}

export interface EdgeHostPolicy {
  /** Host name served by the Worker (Custom Domain or route in this zone). */
  host: string;
  /** Entra app (client) ID the tokens must be issued for: the echo MCP app or the agent's blueprint. */
  audience: string;
  /** Only tokens issued to agent identities (xms_par_app_azp is a GUID). */
  requireAgent?: boolean;
  /** Only agents of these blueprints (xms_par_app_azp allow-list). */
  allowedBlueprints?: string[];
  /** Paths that stay public (metadata, health). /.well-known/* and OPTIONS are always exempt. */
  publicPaths?: string[];
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * WAF custom rule expression that MATCHES violations (the rule then blocks or
 * logs). Every claim test is written as `not (claim eq ...)` so that a missing
 * claim counts as a violation (fail closed).
 */
export function ruleExpression(configId: string, issuer: string, policy: EdgeHostPolicy): string {
  const claims = `http.request.jwt.claims[${quote(configId)}][0]`;
  const claim = (name: string) => `lookup_json_string(${claims}, ${quote(name)})`;
  const anyOf = (name: string, values: string[]) => `(${values.map((v) => `${claim(name)} eq ${quote(v)}`).join(" or ")})`;

  const violations = [
    `not any(cf.api_gateway.tokens.valid[*] == ${quote(configId)})`,
    `not ${anyOf("iss", [issuer])}`,
    `not ${anyOf("aud", [policy.audience, `api://${policy.audience}`])}`,
  ];
  if (policy.allowedBlueprints?.length) violations.push(`not ${anyOf("xms_par_app_azp", policy.allowedBlueprints)}`);
  else if (policy.requireAgent) violations.push(`not (${claim("xms_par_app_azp")} matches "^[0-9a-fA-F-]{36}$")`);

  const exempt = [
    `http.request.method eq "OPTIONS"`,
    `starts_with(http.request.uri.path, "/.well-known/")`,
    ...(policy.publicPaths ?? []).map((p) => `http.request.uri.path eq ${quote(p)}`),
  ];
  return `http.host eq ${quote(policy.host)} and not (${exempt.join(" or ")}) and (${violations.join(" or ")})`;
}

export interface CustomRule {
  ref: string;
  description: string;
  expression: string;
  action: "block" | "log";
  action_parameters?: Record<string, unknown>;
  enabled: boolean;
}

/** Rule for one host. "block" answers 401 with a JSON body (custom response). */
export function edgeRule(configId: string, issuer: string, policy: EdgeHostPolicy, action: "block" | "log"): CustomRule {
  const rule: CustomRule = {
    ref: `agentid_entra_${policy.host.replace(/[^a-zA-Z0-9]+/g, "_")}`.slice(0, 64),
    description: `Entra Agent ID: valid Entra token for ${policy.audience} required on ${policy.host}`,
    expression: ruleExpression(configId, issuer, policy),
    action,
    enabled: true,
  };
  if (action === "block") {
    rule.action_parameters = {
      response: {
        status_code: 401,
        content_type: "application/json",
        content: JSON.stringify({ error: "invalid_token", error_description: "Rejected at the Cloudflare edge: no valid Microsoft Entra token for this API" }),
      },
    };
  }
  return rule;
}

interface Ruleset {
  id: string;
  rules?: { id: string; ref?: string; description?: string }[];
}

/** Adds the rule to the zone's custom rules phase, or updates the rule with the same ref. */
export async function ensureCustomRule(opts: CloudflareApiOptions, zoneId: string, rule: CustomRule): Promise<{ rulesetId: string; created: boolean }> {
  const entrypoint = await cf<Ruleset>(opts, "GET", `/zones/${zoneId}/rulesets/phases/${CUSTOM_RULES_PHASE}/entrypoint`);
  if (entrypoint.status === 404 || !entrypoint.result) {
    const created = await cf<Ruleset>(opts, "POST", `/zones/${zoneId}/rulesets`, {
      name: "default",
      kind: "zone",
      phase: CUSTOM_RULES_PHASE,
      rules: [rule],
    });
    return { rulesetId: created.result?.id ?? "", created: true };
  }
  const rulesetId = entrypoint.result.id;
  const existing = (entrypoint.result.rules ?? []).find((r) => r.ref === rule.ref);
  if (existing) {
    await cf(opts, "PATCH", `/zones/${zoneId}/rulesets/${rulesetId}/rules/${existing.id}`, rule);
    return { rulesetId, created: false };
  }
  await cf(opts, "POST", `/zones/${zoneId}/rulesets/${rulesetId}/rules`, rule);
  return { rulesetId, created: true };
}
