/**
 * Contract test for the Cloudflare-native echo MCP server (src/echo-mcp):
 * OAuthResourceServer + createMcpHandler + McpServer are replaced by stand-ins
 * that follow their documented behaviour (test/support/stubs), so this checks
 * OUR wiring: the Entra Agent ID validator, error mapping, ctx.props -> tools,
 * the rate limit. It does not prove the real packages behave the same way;
 * `wrangler dev` with the real packages does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "agents/mcp/server";
import worker, { entraAgentIdValidator, type NativeEchoEnv } from "../src/echo-mcp/index.ts";
import { withHostHeader } from "../src/shared/host-header.ts";
import { McpHttpError, McpClient, withMcpClient } from "../src/shared/mcp/mcp-client.ts";
import { bytesToBase64Url, jsonToBase64Url, toArrayBuffer, utf8Encode } from "../src/shared/entra/encoding.ts";
import { clearSigningKeyCache } from "../src/shared/entra/inbound-auth.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ECHO = "66666666-6666-6666-6666-666666666666";
const AGENT = "77777777-7777-7777-7777-777777777777";
const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const MCP_URL = "https://echo.example/mcp";

const keyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
// The Worker uses the global fetch for Entra's metadata and keys.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("openid-configuration")) return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: "https://keys.example" }));
  if (url.startsWith("https://keys.example")) return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", use: "sig" }] }));
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

async function token(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: ECHO, iss: ISSUER, tid: TENANT, ver: "2.0", iat: now, nbf: now, exp: now + 600, azp: AGENT, ...claims };
  const input = `${jsonToBase64Url({ alg: "RS256", kid: "k1", typ: "JWT" })}.${jsonToBase64Url(body)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, toArrayBuffer(utf8Encode(input))));
  return `${input}.${bytesToBase64Url(sig)}`;
}

const baseEnv: NativeEchoEnv = { TENANT_ID: TENANT, ECHO_APP_ID: ECHO };
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: undefined }) as unknown as ExecutionContext;
const workerFetchFor =
  (env: NativeEchoEnv): typeof fetch =>
  async (input, init) =>
    worker.fetch(new Request(String(input), init), env, ctx());

const flows = {
  "agent-obo": { scp: "Echo.Read", oid: "user-oid", preferred_username: "adele@contoso.com", idtyp: "user", xms_par_app_azp: BLUEPRINT, xms_act_fct: "11" },
  "agent-app-only": { roles: ["Echo.Read.All"], oid: AGENT, idtyp: "app", xms_par_app_azp: BLUEPRINT, xms_act_fct: "11", xms_sub_fct: "11" },
  "agent-user": { scp: "Echo.Read", oid: "agent-user-oid", upn: "agent@contoso.com", idtyp: "user", xms_par_app_azp: BLUEPRINT, xms_sub_fct: "13" },
};

for (const [flow, claims] of Object.entries(flows)) {
  test(`native: whoami sees the ${flow} caller through getMcpAuthContext and ctx.auth`, async () => {
    clearSigningKeyCache();
    const accessToken = await token(claims);
    const result = await withMcpClient({ url: MCP_URL, accessToken, fetchImpl: workerFetchFor(baseEnv) }, async (client) => {
      assert.deepEqual((await client.listTools()).map((t) => t.name), ["whoami", "echo"]);
      return client.callTool("whoami");
    });
    const identity = result.structuredContent as Record<string, unknown>;
    assert.equal(identity.flow, flow);
    assert.equal(identity.parentBlueprintAppId, BLUEPRINT);
    const verified = identity.verifiedByCloudflare as Record<string, unknown>;
    assert.equal(verified.clientId, AGENT);
    assert.ok(Array.isArray(verified.scopes) && (verified.scopes as string[]).length === 1);
    assert.ok(!JSON.stringify(result).includes(accessToken), "the token never reaches tool output");
  });
}

test("native: echo validates input with the tool schema", async () => {
  clearSigningKeyCache();
  const accessToken = await token(flows["agent-obo"]);
  await withMcpClient({ url: MCP_URL, accessToken, fetchImpl: workerFetchFor(baseEnv) }, async (client) => {
    const ok = await client.callTool("echo", { message: "hi" });
    assert.equal((ok.structuredContent as Record<string, unknown>).echo, "hi");
    const bad = await client.callTool("echo", { message: 42 });
    assert.equal(bad.isError, true);
  });
});

test("native: error mapping (401 invalid token, 403 non-agent, 403 missing role, 429 rate limit)", async () => {
  clearSigningKeyCache();
  const call = async (env: NativeEchoEnv, accessToken: string) =>
    assert.rejects(new McpClient({ url: MCP_URL, accessToken, fetchImpl: workerFetchFor(env) }).connect(), (err: unknown) => {
      assert.ok(err instanceof McpHttpError);
      return (call.last = err), true;
    }).then(() => call.last as McpHttpError);
  call.last = undefined as McpHttpError | undefined;

  const wrongAudience = await call(baseEnv, await token({ ...flows["agent-obo"], aud: "api://someone-else" }));
  assert.equal(wrongAudience.status, 401);
  assert.match(wrongAudience.wwwAuthenticate ?? "", /resource_metadata="https:\/\/echo\.example\/\.well-known\/oauth-protected-resource\/mcp"/);

  const notAnAgent = await call(baseEnv, await token({ scp: "Echo.Read", oid: "u", idtyp: "user" }));
  assert.equal(notAnAgent.status, 403);

  const noRole = await call(baseEnv, await token({ ...flows["agent-app-only"], roles: [] }));
  assert.equal(noRole.status, 403);
  assert.match(noRole.wwwAuthenticate ?? "", /insufficient_scope/);

  const limiter = { limit: async () => ({ success: false }) };
  const limited = await call({ ...baseEnv, AGENT_RATE_LIMITER: limiter }, await token(flows["agent-app-only"]));
  assert.equal(limited.status, 429);
});

test("native: validator binds the Entra token to the MCP resource and reports scopes/roles", async () => {
  clearSigningKeyCache();
  const validate = entraAgentIdValidator(baseEnv);
  const result = await validate(MCP_URL, await token(flows["agent-app-only"]));
  assert.equal(result.audience, MCP_URL);
  assert.deepEqual(result.scope, ["Echo.Read.All"]);
  assert.equal(result.clientId, AGENT);
  assert.equal(result.props.caller.flow, "agent-app-only");
});

test("native: info and protected resource metadata", async () => {
  const info = await worker.fetch(new Request("https://echo.example/"), baseEnv, ctx());
  assert.equal(((await info.json()) as Record<string, unknown>).authorizationServer, ISSUER);
  const prm = await worker.fetch(new Request("https://echo.example/.well-known/oauth-protected-resource/mcp"), baseEnv, ctx());
  const metadata = (await prm.json()) as Record<string, unknown>;
  assert.equal(metadata.resource, MCP_URL);
  assert.deepEqual(metadata.authorization_servers, [ISSUER]);
  assert.deepEqual(metadata.scopes_supported, [`api://${ECHO}/Echo.Read`]);
});

const WORKERS_DEV_URL = "https://agentid-cf-echo-mcp.contoso.workers.dev/mcp";

test("native: a service binding call has no Host header; the echo server gives it the host of its URL", async () => {
  clearSigningKeyCache();
  // What the deployed MCP handler answered such a call before the fix:
  const bare = createMcpHandler(() => {
    throw new Error("not reached");
  });
  const refused = await bare(new Request(WORKERS_DEV_URL, { method: "POST", body: "{}" }), {}, ctx());
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { jsonrpc: "2.0", error: { code: -32000, message: "Missing Host header" }, id: null });

  // The echo Worker called the way a service binding calls it: no Host header.
  const accessToken = await token(flows["agent-obo"]);
  const result = await withMcpClient({ url: WORKERS_DEV_URL, accessToken, fetchImpl: workerFetchFor(baseEnv) }, (client) => client.callTool("whoami"));
  const identity = result.structuredContent as Record<string, unknown>;
  assert.equal(identity.flow, "agent-obo");
  assert.equal(identity.parentBlueprintAppId, BLUEPRINT);
});

test("native: a wrong Host header is still refused (DNS rebinding protection stays on)", async () => {
  clearSigningKeyCache();
  const accessToken = await token(flows["agent-obo"]);
  const withWrongHost: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("host", "attacker.example");
    return worker.fetch(new Request(String(input), { ...init, headers }), baseEnv, ctx());
  };
  await assert.rejects(new McpClient({ url: WORKERS_DEV_URL, accessToken, fetchImpl: withWrongHost }).connect(), (err: unknown) => {
    assert.ok(err instanceof McpHttpError);
    assert.equal(err.status, 403);
    assert.match(err.message, /Invalid Host: attacker\.example/);
    return true;
  });
});

test("withHostHeader adds the host of the URL only when the request has none", async () => {
  const added = withHostHeader(new Request("https://echo.contoso.com:8443/mcp", { method: "POST", headers: { authorization: "Bearer t" }, body: "b" }));
  assert.equal(added.headers.get("host"), "echo.contoso.com:8443");
  assert.equal(added.headers.get("authorization"), "Bearer t");
  assert.equal(added.method, "POST");
  assert.equal(await added.text(), "b");
  const kept = new Request("https://echo.contoso.com/mcp", { headers: { host: "other.example" } });
  assert.equal(withHostHeader(kept), kept);
});
