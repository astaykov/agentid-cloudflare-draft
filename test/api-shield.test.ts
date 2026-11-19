/** Edge authorizer helpers: Entra keys -> API Shield, rule expressions, idempotent API calls (fake API). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeRule, ensureCustomRule, ensureTokenConfiguration, entraSigningKeys, ruleExpression } from "../src/shared/cloudflare/api-shield.ts";
import { syncKeys } from "../src/edge-jwks-sync/index.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ZONE = "0123456789abcdef0123456789abcdef";
const ECHO = "66666666-6666-6666-6666-666666666666";
const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const entraFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/openid-configuration")) return Response.json({ issuer: ISSUER, jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` });
  return Response.json({
    keys: [
      { kty: "RSA", use: "sig", kid: "k1", x5t: "k1", n: "nnn", e: "AQAB", x5c: ["MIIC..."], issuer: ISSUER },
      { kty: "RSA", kid: "k2", n: "mmm", e: "AQAB" },
      { kty: "EC", kid: "ec", crv: "P-256", x: "x", y: "y" },
      { kty: "RSA", use: "enc", kid: "enc", n: "o", e: "AQAB" },
    ],
  });
};

test("Entra keys are reduced to RSA signing JWKs with alg RS256", async () => {
  const keys = await entraSigningKeys(TENANT, undefined, entraFetch);
  assert.deepEqual(keys, [
    { kty: "RSA", kid: "k1", n: "nnn", e: "AQAB", alg: "RS256", use: "sig" },
    { kty: "RSA", kid: "k2", n: "mmm", e: "AQAB", alg: "RS256", use: "sig" },
  ]);
});

test("rule expression: valid token, issuer, audience, blueprint; metadata and preflight exempt", () => {
  const expr = ruleExpression("cfg-1", ISSUER, { host: "echo-mcp.contoso.com", audience: ECHO, allowedBlueprints: [BLUEPRINT], publicPaths: ["/"] });
  assert.match(expr, /^http\.host eq "echo-mcp\.contoso\.com" and not \(/);
  assert.ok(expr.includes('not any(cf.api_gateway.tokens.valid[*] == "cfg-1")'));
  assert.ok(expr.includes(`lookup_json_string(http.request.jwt.claims["cfg-1"][0], "iss") eq "${ISSUER}"`));
  assert.ok(expr.includes(`eq "api://${ECHO}"`));
  assert.ok(expr.includes(`"xms_par_app_azp") eq "${BLUEPRINT}"`));
  assert.ok(expr.includes('http.request.method eq "OPTIONS"'));
  assert.ok(expr.includes('starts_with(http.request.uri.path, "/.well-known/")'));
  const agentOnly = ruleExpression("cfg-1", ISSUER, { host: "a.contoso.com", audience: ECHO, requireAgent: true });
  assert.ok(agentOnly.includes('"xms_par_app_azp") matches "^[0-9a-fA-F-]{36}$"'));
  const blocked = edgeRule("cfg-1", ISSUER, { host: "a.contoso.com", audience: ECHO }, "block");
  assert.equal((blocked.action_parameters?.response as { status_code: number }).status_code, 401);
  assert.equal(blocked.ref, "agentid_entra_a_contoso_com");
});

/** A tiny in-memory Cloudflare API. */
function fakeCloudflare() {
  const calls: string[] = [];
  const state = { configs: [] as { id: string; title: string; keys: unknown[] }[], ruleset: undefined as undefined | { id: string; rules: { id: string; ref: string }[] } };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${path}`);
    assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer cf-token$/);
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (path === `/zones/${ZONE}/token_validation/config` && method === "GET") return ok(state.configs.map(({ id, title }) => ({ id, title })));
    if (path === `/zones/${ZONE}/token_validation/config` && method === "POST") {
      assert.equal(body.token_type, "jwt");
      assert.deepEqual(body.token_sources, ['http.request.headers["authorization"][0]']);
      const config = { id: `cfg-${state.configs.length + 1}`, title: body.title, keys: body.credentials.keys };
      state.configs.push(config);
      return ok({ id: config.id });
    }
    const credentials = /^\/zones\/[^/]+\/token_validation\/config\/([^/]+)\/credentials$/.exec(path);
    if (credentials && method === "PUT") {
      state.configs.find((c) => c.id === credentials[1])!.keys = body.keys;
      return ok({ keys: body.keys });
    }
    if (path === `/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`) {
      if (!state.ruleset) return Response.json({ success: false, errors: [{ code: 10003, message: "not found" }] }, { status: 404 });
      return ok(state.ruleset);
    }
    if (path === `/zones/${ZONE}/rulesets` && method === "POST") {
      state.ruleset = { id: "rs-1", rules: body.rules.map((r: { ref: string }, i: number) => ({ id: `r-${i}`, ref: r.ref })) };
      return ok(state.ruleset);
    }
    if (path === `/zones/${ZONE}/rulesets/rs-1/rules` && method === "POST") {
      state.ruleset!.rules.push({ id: `r-${state.ruleset!.rules.length}`, ref: body.ref });
      return ok(state.ruleset);
    }
    if (path.startsWith(`/zones/${ZONE}/rulesets/rs-1/rules/`) && method === "PATCH") return ok(state.ruleset);
    return Response.json({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] }, { status: 400 });
  };
  return { calls, state, fetchImpl };
}

test("token configuration and custom rules are created once, then updated in place", async () => {
  const cf = fakeCloudflare();
  const api = { apiToken: "cf-token", fetchImpl: cf.fetchImpl };
  const keys = await entraSigningKeys(TENANT, undefined, entraFetch);
  const first = await ensureTokenConfiguration(api, ZONE, "Entra ID test", "desc", keys);
  const second = await ensureTokenConfiguration(api, ZONE, "Entra ID test", "desc", keys.slice(0, 1));
  assert.deepEqual([first.created, second.created, first.id === second.id], [true, false, true]);
  assert.equal(cf.state.configs[0].keys.length, 1);

  const echoRule = edgeRule(first.id, ISSUER, { host: "echo-mcp.contoso.com", audience: ECHO, requireAgent: true }, "log");
  const agentRule = edgeRule(first.id, ISSUER, { host: "agent.contoso.com", audience: BLUEPRINT }, "log");
  assert.equal((await ensureCustomRule(api, ZONE, echoRule)).created, true); // creates the phase entry point
  assert.equal((await ensureCustomRule(api, ZONE, agentRule)).created, true); // adds a rule
  assert.equal((await ensureCustomRule(api, ZONE, echoRule)).created, false); // updates by ref
  assert.ok(cf.calls.includes(`PATCH /zones/${ZONE}/rulesets/rs-1/rules/r-0`));
});

test("edge-jwks-sync Worker pushes the current Entra keys (PUT replaces the set)", async () => {
  const cf = fakeCloudflare();
  cf.state.configs.push({ id: "cfg-9", title: "t", keys: [] });
  const both: typeof fetch = async (input, init) => (String(input).includes("api.cloudflare.com") ? cf.fetchImpl(input, init) : entraFetch(input, init));
  const result = await syncKeys({ CF_API_TOKEN: "cf-token", ZONE_ID: ZONE, TOKEN_CONFIG_ID: "cfg-9", TENANT_ID: TENANT }, both);
  assert.deepEqual(result.kids, ["k1", "k2"]);
  assert.equal(cf.state.configs[0].keys.length, 2);
});
