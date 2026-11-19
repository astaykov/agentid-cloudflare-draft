/**
 * End-to-end over HTTP semantics: our MCP client talks to the dependency-free
 * echo MCP server (src/echo-mcp-lite) with tokens shaped like the three Agent ID
 * flows. The Cloudflare-native edition shares the same guard (src/echo-mcp/common.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleEchoRequest } from "../src/echo-mcp-lite/server.ts";
import type { EchoEnv } from "../src/echo-mcp/common.ts";
import { McpClient, McpHttpError, withMcpClient } from "../src/shared/mcp/mcp-client.ts";
import { bytesToBase64Url, jsonToBase64Url, toArrayBuffer, utf8Encode } from "../src/shared/entra/encoding.ts";
import { clearSigningKeyCache } from "../src/shared/entra/inbound-auth.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ECHO = "66666666-6666-6666-6666-666666666666";
const AGENT = "77777777-7777-7777-7777-777777777777";
const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const keyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const entraFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("openid-configuration")) return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: "https://keys" }));
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", use: "sig" }] }));
};
async function token(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: ECHO, iss: ISSUER, tid: TENANT, ver: "2.0", iat: now, nbf: now, exp: now + 600, azp: AGENT, ...claims };
  const input = `${jsonToBase64Url({ alg: "RS256", kid: "k1", typ: "JWT" })}.${jsonToBase64Url(body)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, toArrayBuffer(utf8Encode(input))));
  return `${input}.${bytesToBase64Url(sig)}`;
}
const baseEnv: EchoEnv = { TENANT_ID: TENANT, ECHO_APP_ID: ECHO };
// Route the MCP client's fetch straight into the Worker handler.
const workerFetchFor =
  (env: EchoEnv): typeof fetch =>
  async (input, init) =>
    handleEchoRequest(new Request(String(input), init), env, { fetchImpl: entraFetch });
const workerFetch = workerFetchFor(baseEnv);

const flows = {
  obo: { scp: "Echo.Read", oid: "user-oid", preferred_username: "adele@contoso.com", idtyp: "user", xms_par_app_azp: BLUEPRINT, xms_act_fct: "11" },
  appOnly: { roles: ["Echo.Read.All"], oid: AGENT, idtyp: "app", xms_par_app_azp: BLUEPRINT, xms_act_fct: "11", xms_sub_fct: "11" },
  agentUser: { scp: "Echo.Read", oid: "agent-user-oid", upn: "agent@contoso.com", idtyp: "user", xms_par_app_azp: BLUEPRINT, xms_sub_fct: "13" },
};
const expectedFlow = { obo: "agent-obo", appOnly: "agent-app-only", agentUser: "agent-user" } as const;

for (const [flow, claims] of Object.entries(flows)) {
  test(`whoami over MCP for the ${flow} flow`, async () => {
    clearSigningKeyCache();
    const accessToken = await token(claims);
    const result = await withMcpClient({ url: "https://echo.example/mcp", accessToken, fetchImpl: workerFetch }, async (client) => {
      assert.deepEqual((await client.listTools()).map((t) => t.name), ["whoami", "echo"]);
      return client.callTool("whoami");
    });
    const identity = result.structuredContent as Record<string, string>;
    assert.equal(identity.flow, expectedFlow[flow as keyof typeof expectedFlow]);
    const expected = { obo: /on behalf of user adele/, appOnly: /application permissions \(app-only\)/, agentUser: /agent user/ }[flow]!;
    assert.match(identity.interpretation, expected);
    assert.equal(identity.clientAppId, AGENT);
    assert.equal(identity.parentBlueprintAppId, BLUEPRINT);
  });
}

test("echo returns the message and the caller's flow", async () => {
  clearSigningKeyCache();
  const accessToken = await token(flows.obo);
  const result = await withMcpClient({ url: "https://echo.example/mcp", accessToken, fetchImpl: workerFetch }, (client) =>
    client.callTool("echo", { message: "hello" }),
  );
  assert.deepEqual((result.structuredContent as Record<string, string>).echo, "hello");
  assert.equal((result.structuredContent as Record<string, string>).flow, "agent-obo");
});

test("non-agent callers get 403 without a challenge; a wrong audience gets 401 with one", async () => {
  clearSigningKeyCache();
  const plainUser = await token({ scp: "Echo.Read", oid: "u", idtyp: "user" }); // no xms_par_app_azp
  await assert.rejects(new McpClient({ url: "https://echo.example/mcp", accessToken: plainUser, fetchImpl: workerFetch }).connect(), (err: unknown) => {
    assert.ok(err instanceof McpHttpError);
    assert.equal(err.status, 403);
    assert.equal(err.wwwAuthenticate, undefined);
    assert.match(err.message, /The token has no Agent ID claims/);
    assert.match(err.message, /optional claims/);
    return true;
  });
  const wrongAudience = await token({ aud: "api://other", scp: "Echo.Read", xms_par_app_azp: BLUEPRINT });
  await assert.rejects(new McpClient({ url: "https://echo.example/mcp", accessToken: wrongAudience, fetchImpl: workerFetch }).connect(), (err: unknown) => {
    assert.ok(err instanceof McpHttpError);
    assert.equal(err.status, 401);
    assert.match(err.wwwAuthenticate ?? "", /resource_metadata="https:\/\/echo\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(err.wwwAuthenticate ?? "", new RegExp(`scope="api://${ECHO}/Echo.Read"`));
    return true;
  });
});

test("app token without the app role is refused (403 insufficient_scope)", async () => {
  clearSigningKeyCache();
  const noRole = await token({ roles: [], idtyp: "app", oid: AGENT, xms_par_app_azp: BLUEPRINT });
  await assert.rejects(new McpClient({ url: "https://echo.example/mcp", accessToken: noRole, fetchImpl: workerFetch }).connect(), (err: unknown) => {
    assert.ok(err instanceof McpHttpError);
    assert.equal(err.status, 403);
    assert.match(err.wwwAuthenticate ?? "", /insufficient_scope/);
    return true;
  });
});

test("caller policy: blueprint allow-list and allowed flows", async () => {
  clearSigningKeyCache();
  const obo = await token(flows.obo);
  const appOnly = await token(flows.appOnly);
  const otherBlueprint = workerFetchFor({ ...baseEnv, ALLOWED_BLUEPRINT_IDS: "33333333-3333-3333-3333-333333333333" });
  await assert.rejects(new McpClient({ url: "https://echo.example/mcp", accessToken: obo, fetchImpl: otherBlueprint }).connect(), (err: unknown) => err instanceof McpHttpError && err.status === 403);
  const sameBlueprint = workerFetchFor({ ...baseEnv, ALLOWED_BLUEPRINT_IDS: BLUEPRINT.toUpperCase() });
  await withMcpClient({ url: "https://echo.example/mcp", accessToken: obo, fetchImpl: sameBlueprint }, (client) => client.listTools());
  const oboOnly = workerFetchFor({ ...baseEnv, ALLOWED_CALLER_FLOWS: "agent-obo" });
  await withMcpClient({ url: "https://echo.example/mcp", accessToken: obo, fetchImpl: oboOnly }, (client) => client.listTools());
  await assert.rejects(new McpClient({ url: "https://echo.example/mcp", accessToken: appOnly, fetchImpl: oboOnly }).connect(), (err: unknown) => err instanceof McpHttpError && err.status === 403);
});

test("per-agent rate limit (Workers Rate Limiting binding) answers 429", async () => {
  clearSigningKeyCache();
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length <= 1 }) };
  const limited = workerFetchFor({ ...baseEnv, AGENT_RATE_LIMITER: limiter });
  const accessToken = await token(flows.appOnly);
  const client = new McpClient({ url: "https://echo.example/mcp", accessToken, fetchImpl: limited });
  await assert.rejects(client.connect(), (err: unknown) => err instanceof McpHttpError && err.status === 429);
  assert.equal(keys[0], AGENT);
});

test("protected resource metadata points MCP clients to Entra", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await handleEchoRequest(new Request(`https://echo.example${path}`), baseEnv);
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.equal(metadata.resource, "https://echo.example/mcp");
    assert.deepEqual(metadata.authorization_servers, [ISSUER]);
    assert.deepEqual(metadata.scopes_supported, [`api://${ECHO}/Echo.Read`]);
  }
});
