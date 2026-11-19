/**
 * The interactive agent with two MCP servers: a fake "enterprise" server and the
 * real dependency-free echo MCP server (src/echo-mcp-lite), each reached with its
 * own token, as the agent does with one on-behalf-of token per server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleEchoRequest } from "../src/echo-mcp-lite/server.ts";
import type { EchoEnv } from "../src/echo-mcp/common.ts";
import { bytesToBase64Url, jsonToBase64Url, toArrayBuffer, utf8Encode } from "../src/shared/entra/encoding.ts";
import { clearSigningKeyCache } from "../src/shared/entra/inbound-auth.ts";
import { McpHttpError, mcpFetcher } from "../src/shared/mcp/mcp-client.ts";
import { McpServerSet, readMcpServers, routeTools, UnknownToolError, type McpServerConfig } from "../src/shared/mcp/mcp-servers.ts";
import {
  buildSystemPrompt,
  DEFAULT_CHAT_MODEL,
  INTERACTIVE_MCP_SERVERS,
  resolveChatModel,
  routedToolName,
  toolsForModel,
  unavailableReason,
} from "../src/interactive/servers.ts";
import { runToolLoop, type AiBinding } from "../src/shared/agent/tool-loop.ts";
import { toolResultToText } from "../src/shared/mcp/mcp-client.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ECHO_APP = "66666666-6666-6666-6666-666666666666";
const AGENT = "77777777-7777-7777-7777-777777777777";
const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ENTERPRISE_URL = "https://mcp.svc.cloud.microsoft/enterprise";
const ECHO_URL = "https://agentid-cf-echo-mcp.contoso.workers.dev/mcp";

// ---------- configuration ----------

test("only MCP Server for Enterprise by default; the echo server is off until ECHO_MCP_URL is set", () => {
  const env = { MCP_SERVER_URL: ENTERPRISE_URL, MCP_SCOPES: "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default", ECHO_MCP_URL: "", ECHO_MCP_SCOPES: "" };
  const { servers, problems } = readMcpServers(env, INTERACTIVE_MCP_SERVERS);
  assert.deepEqual(servers.map((s) => s.id), ["enterprise"]);
  assert.deepEqual(servers[0].scopes, ["api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default"]);
  assert.deepEqual(problems, []);
});

test("ECHO_MCP_URL and ECHO_MCP_SCOPES add the echo server, with its service binding when present", () => {
  const binding = { fetch: async () => new Response("") };
  const env = {
    MCP_SERVER_URL: ENTERPRISE_URL,
    MCP_SCOPES: "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default",
    ECHO_MCP_URL: ` ${ECHO_URL} `,
    ECHO_MCP_SCOPES: `api://${ECHO_APP}/Echo.Read`,
    ECHO_MCP_SERVICE: binding,
  };
  const { servers, problems } = readMcpServers(env, INTERACTIVE_MCP_SERVERS);
  assert.deepEqual(problems, []);
  assert.deepEqual(servers.map((s) => [s.id, s.url, s.scopes]), [
    ["enterprise", ENTERPRISE_URL, ["api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default"]],
    ["echo", ECHO_URL, [`api://${ECHO_APP}/Echo.Read`]],
  ]);
  assert.equal(servers[0].service, undefined);
  assert.equal(servers[1].service, binding);
});

test("an incomplete echo configuration is reported for the echo server only", () => {
  const base = { MCP_SERVER_URL: ENTERPRISE_URL, MCP_SCOPES: "x/.default" };
  let result = readMcpServers({ ...base, ECHO_MCP_URL: ECHO_URL }, INTERACTIVE_MCP_SERVERS);
  assert.deepEqual(result.servers.map((s) => s.id), ["enterprise"]);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].id, "echo");
  assert.match(result.problems[0].message, /ECHO_MCP_SCOPES is not set, for example api:\/\/<echo app id>\/Echo\.Read/);

  result = readMcpServers({ ...base, ECHO_MCP_URL: "agentid-cf-echo-mcp.contoso.workers.dev/mcp", ECHO_MCP_SCOPES: "s" }, INTERACTIVE_MCP_SERVERS);
  assert.match(result.problems[0].message, /ECHO_MCP_URL is not a valid URL/);
  result = readMcpServers({ ...base, ECHO_MCP_URL: "http://echo.contoso.com/mcp", ECHO_MCP_SCOPES: "s" }, INTERACTIVE_MCP_SERVERS);
  assert.match(result.problems[0].message, /must be an https:\/\/ URL/);
  result = readMcpServers({ ...base, ECHO_MCP_URL: "http://localhost:8789/mcp", ECHO_MCP_SCOPES: "s" }, INTERACTIVE_MCP_SERVERS);
  assert.deepEqual(result.servers.map((s) => s.id), ["enterprise", "echo"], "wrangler dev on localhost may use http");

  result = readMcpServers({ ECHO_MCP_URL: ECHO_URL, ECHO_MCP_SCOPES: "s" }, INTERACTIVE_MCP_SERVERS);
  assert.deepEqual(result.problems, [{ id: "enterprise", message: "MCP_SERVER_URL is not set" }]);
  assert.deepEqual(result.servers.map((s) => s.id), ["echo"]);
});

test("tool names stay as they are unless two servers use the same name", () => {
  const routed = routeTools([
    { server: { id: "enterprise" }, tools: [{ name: "microsoft_graph_get", inputSchema: {} }, { name: "whoami", inputSchema: {} }] },
    { server: { id: "echo" }, tools: [{ name: "whoami", inputSchema: {} }, { name: "echo", inputSchema: {} }] },
  ]);
  assert.deepEqual(
    routed.map((t) => [t.name, t.server, t.originalName]),
    [
      ["microsoft_graph_get", "enterprise", "microsoft_graph_get"],
      ["enterprise_whoami", "enterprise", "whoami"],
      ["echo_whoami", "echo", "whoami"],
      ["echo", "echo", "echo"],
    ],
  );
});

// ---------- two servers, one token each ----------

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

/** A token shaped like the agent's OBO token for the echo server (azp = agent identity, oid = user). */
async function oboTokenForEcho(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    aud: ECHO_APP, iss: ISSUER, tid: TENANT, ver: "2.0", iat: now, nbf: now, exp: now + 600,
    azp: AGENT, idtyp: "user", scp: "Echo.Read", oid: "user-oid", preferred_username: "adele@contoso.com",
    xms_par_app_azp: BLUEPRINT, xms_act_fct: "11",
  };
  const input = `${jsonToBase64Url({ alg: "RS256", kid: "k1", typ: "JWT" })}.${jsonToBase64Url(body)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, toArrayBuffer(utf8Encode(input))));
  return `${input}.${bytesToBase64Url(sig)}`;
}

const echoEnv: EchoEnv = { TENANT_ID: TENANT, ECHO_APP_ID: ECHO_APP, ALLOWED_BLUEPRINT_IDS: BLUEPRINT };
const echoWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  handleEchoRequest(input instanceof Request ? input : new Request(String(input), init), echoEnv, { fetchImpl: entraFetch });

/** Stand-in for MCP Server for Enterprise: records the bearer token it received. */
function fakeEnterprise(options: { status?: number } = {}) {
  const seen: { method: string; authorization?: string; rpc?: string }[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", authorization: headers.get("authorization") ?? undefined, rpc: body?.method });
    if (options.status) return new Response("no", { status: options.status, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    if (!body?.id) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "enterprise-fake", version: "1" } };
    else if (body.method === "tools/list") {
      result = { tools: [{ name: "microsoft_graph_suggest_queries", inputSchema: { type: "object" } }, { name: "microsoft_graph_get", inputSchema: { type: "object" } }] };
    } else result = { content: [{ type: "text", text: `enterprise ran ${body.params.name}` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      headers: { "content-type": "application/json", "mcp-session-id": "enterprise-session" },
    });
  };
  return { seen, fetchImpl };
}

function servers(enterpriseFetch: typeof fetch, viaServiceBinding = false): { list: McpServerConfig[]; fetchImpl: typeof fetch } {
  const list: McpServerConfig[] = [
    { id: "enterprise", url: ENTERPRISE_URL, scopes: ["api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default"] },
    { id: "echo", url: ECHO_URL, scopes: [`api://${ECHO_APP}/Echo.Read`], ...(viaServiceBinding ? { service: { fetch: echoWorker } } : {}) },
  ];
  // Public path: route by host. With the service binding, echo requests never reach this fetch.
  const fetchImpl: typeof fetch = async (input, init) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    if (host === "mcp.svc.cloud.microsoft") return enterpriseFetch(input, init);
    if (viaServiceBinding) throw new Error("echo request took the public path");
    return echoWorker(input, init);
  };
  return { list, fetchImpl };
}

for (const viaServiceBinding of [false, true]) {
  test(`each server gets its own token; tools are merged and routed${viaServiceBinding ? " (echo over a service binding)" : ""}`, async () => {
    clearSigningKeyCache();
    const enterprise = fakeEnterprise();
    const echoToken = await oboTokenForEcho();
    const requested: string[] = [];
    const { list, fetchImpl } = servers(enterprise.fetchImpl, viaServiceBinding);
    const set = await McpServerSet.connect({
      servers: list,
      fetchImpl,
      getToken: async (server) => {
        requested.push(server.scopes.join(" "));
        return server.id === "echo" ? echoToken : "enterprise-token";
      },
    });
    try {
      assert.deepEqual(set.failures, []);
      assert.deepEqual(requested.sort(), [`api://${ECHO_APP}/Echo.Read`, "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default"].sort());
      assert.deepEqual(set.tools.map((t) => `${t.server}/${t.name}`), [
        "enterprise/microsoft_graph_suggest_queries",
        "enterprise/microsoft_graph_get",
        "echo/whoami",
        "echo/echo",
      ]);
      assert.ok(enterprise.seen.every((r) => r.authorization === "Bearer enterprise-token"), "the enterprise server only ever sees its own token");

      const whoami = await set.callTool("whoami", {});
      assert.equal(whoami.server, "echo");
      const identity = whoami.result.structuredContent as Record<string, string>;
      assert.equal(identity.flow, "agent-obo");
      assert.equal(identity.clientAppId, AGENT);
      assert.equal(identity.parentBlueprintAppId, BLUEPRINT);

      const echoed = await set.callTool("echo", { message: "hello from Cloudflare" });
      assert.equal((echoed.result.structuredContent as Record<string, string>).echo, "hello from Cloudflare");

      const graph = await set.callTool("microsoft_graph_get", { relativeUrl: "/users/$count" });
      assert.equal(graph.server, "enterprise");
      assert.equal(graph.result.content[0].text, "enterprise ran microsoft_graph_get");
      assert.equal(enterprise.seen.filter((r) => r.rpc === "tools/call").length, 1);
    } finally {
      await set.close();
    }
    assert.ok(enterprise.seen.some((r) => r.method === "DELETE"), "sessions are closed");
  });
}

test("a server that fails (no consent, 401) is reported on its own; the other one keeps working", async () => {
  clearSigningKeyCache();
  const enterprise = fakeEnterprise();
  const { list, fetchImpl } = servers(enterprise.fetchImpl);
  const set = await McpServerSet.connect({
    servers: list,
    fetchImpl,
    getToken: async (server) => {
      if (server.id === "echo") throw new Error("AADSTS65001: The user or administrator has not consented");
      return "enterprise-token";
    },
  });
  try {
    assert.deepEqual(set.connections.map((c) => c.server.id), ["enterprise"]);
    assert.deepEqual(set.failures.map((f) => f.server.id), ["echo"]);
    assert.match(String((set.failures[0].error as Error).message), /AADSTS65001/);
    assert.deepEqual(set.tools.map((t) => t.server), ["enterprise", "enterprise"]);
    await assert.rejects(set.callTool("whoami", {}), (err: unknown) => {
      assert.ok(err instanceof UnknownToolError);
      assert.deepEqual(err.available, ["microsoft_graph_suggest_queries", "microsoft_graph_get"]);
      return true;
    });
  } finally {
    await set.close();
  }

  // The echo server rejects a token issued for another audience: 401 with its challenge.
  const wrongAudience = await McpServerSet.connect({
    servers: [list[1]],
    fetchImpl,
    getToken: async () => "not-a-jwt",
  });
  assert.equal(wrongAudience.connections.length, 0);
  const error = wrongAudience.failures[0].error;
  assert.ok(error instanceof McpHttpError);
  assert.equal(error.status, 401);
  assert.match(error.wwwAuthenticate ?? "", /resource_metadata=/);
});

test("a call to a named server skips tools/list", async () => {
  const enterprise = fakeEnterprise();
  const { list, fetchImpl } = servers(enterprise.fetchImpl);
  const set = await McpServerSet.connect({ servers: [list[0]], fetchImpl, getToken: async () => "enterprise-token", listTools: false });
  try {
    const call = await set.callTool("microsoft_graph_get", {}, "enterprise");
    assert.equal(call.tool, "microsoft_graph_get");
    assert.deepEqual(enterprise.seen.map((r) => r.rpc).filter(Boolean), ["initialize", "notifications/initialized", "tools/call"]);
    await assert.rejects(set.callTool("whoami", {}, "echo"), UnknownToolError);
  } finally {
    await set.close();
  }
});

test("the model sees the server in each tool description; the prompt explains the servers it has", () => {
  const routed = routeTools([
    { server: { id: "enterprise" }, tools: [{ name: "microsoft_graph_suggest_queries", inputSchema: {} }, { name: "microsoft_graph_get", description: "Runs GET", inputSchema: {} }] },
    { server: { id: "echo" }, tools: [{ name: "whoami", description: "Who am I", inputSchema: {} }, { name: "echo", inputSchema: {} }] },
  ]);
  const forModel = toolsForModel(routed);
  assert.equal(forModel[1].description, "[enterprise MCP server] Runs GET");
  assert.equal(forModel[2].description, "[echo MCP server] Who am I");
  assert.equal(routed[1].description, "Runs GET", "the routed list itself is unchanged");
  // Names as the model sees them: the echo server's tools carry the server, Enterprise's stay.
  assert.deepEqual(
    forModel.map((t) => [t.name, t.routedName, t.server]),
    [
      ["microsoft_graph_suggest_queries", "microsoft_graph_suggest_queries", "enterprise"],
      ["microsoft_graph_get", "microsoft_graph_get", "enterprise"],
      ["echo_server_whoami", "whoami", "echo"],
      ["echo_server_echo", "echo", "echo"],
    ],
  );

  const both = buildSystemPrompt("Adele", forModel);
  assert.match(both, /call microsoft_graph_suggest_queries first .* then call microsoft_graph_get/);
  assert.match(both, /Its echo_server_whoami tool returns how that server sees the caller/);
  assert.match(both, /To find out who is calling the echo server or what it sees, call echo_server_whoami with empty arguments \{\}\./);
  assert.match(both, /Questions about the echo server need no further details from the user\./);
  assert.match(both, /Call echo_server_echo only when the user gives a text to echo\./);
  assert.match(both, /The signed-in user is Adele\./);

  const enterpriseOnly = buildSystemPrompt(undefined, forModel.filter((t) => t.server === "enterprise"));
  assert.doesNotMatch(enterpriseOnly, /echo MCP server is/);
  const echoOnly = buildSystemPrompt(undefined, forModel.filter((t) => t.server === "echo"));
  assert.doesNotMatch(echoOnly, /microsoft_graph_suggest_queries/);
  assert.match(echoOnly, /Its echo_server_echo tool repeats a text the user gives/);
});

test("a server that failed is named in the prompt with its reason, so the model does not guess a tool", () => {
  const routed = routeTools([{ server: { id: "enterprise" }, tools: [{ name: "microsoft_graph_get", inputSchema: {} }] }]);
  const reason = unavailableReason({ type: "mcp_http_error", status: 403, message: 'MCP server returned HTTP 403: {"error":"access_denied"}' });
  assert.equal(reason, 'mcp_http_error: HTTP 403: MCP server returned HTTP 403: {"error":"access_denied"}');
  const prompt = buildSystemPrompt("Adele", routed, [{ id: "echo", reason }]);
  assert.match(prompt, /The echo MCP server is configured but not available for this request/);
  assert.match(prompt, /Reason: mcp_http_error: HTTP 403/);
  assert.match(prompt, /do not use another server's tools instead/);
  assert.match(prompt, /never guess a tool name/);
  assert.match(prompt, /answer the user's latest message, never an earlier question again/);
  assert.doesNotMatch(buildSystemPrompt("Adele", routed), /not available/);
  assert.equal(unavailableReason(undefined), "unknown error");
  assert.ok(unavailableReason({ message: "x".repeat(500) }).length <= 243);
});

test("over a service binding the agent sends the Host of the server's URL; a Host already set is kept", async () => {
  const seen: { url: string; host: string | null; auth: string | null; body: string }[] = [];
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(String(input), init);
      seen.push({ url: request.url, host: request.headers.get("host"), auth: request.headers.get("authorization"), body: await request.text() });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  };
  const viaBinding = mcpFetcher(binding)!;
  await viaBinding(ECHO_URL, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: '{"jsonrpc":"2.0"}' });
  await viaBinding(new Request("https://echo.contoso.com/mcp", { method: "POST", headers: { host: "echo.contoso.com" }, body: "x" }));
  assert.deepEqual(seen, [
    { url: ECHO_URL, host: "agentid-cf-echo-mcp.contoso.workers.dev", auth: "Bearer t", body: '{"jsonrpc":"2.0"}' },
    { url: "https://echo.contoso.com/mcp", host: "echo.contoso.com", auth: null, body: "x" },
  ]);
  assert.equal(mcpFetcher(undefined), undefined, "no binding: the public path, where the runtime sets Host");
});

test("a model-facing name that would clash keeps the routed name", () => {
  const routed = routeTools([
    { server: { id: "enterprise" }, tools: [{ name: "echo_server_whoami", inputSchema: {} }] },
    { server: { id: "echo" }, tools: [{ name: "whoami", inputSchema: {} }] },
  ]);
  const forModel = toolsForModel(routed);
  assert.deepEqual(forModel.map((t) => t.name), ["echo_server_whoami", "whoami"]);
  assert.equal(new Set(forModel.map((t) => t.name)).size, forModel.length);
});

test("chat --model: AI_MODEL by default; another model only from AI_MODEL_CHOICES", () => {
  assert.deepEqual(resolveChatModel({}), { ok: true, model: DEFAULT_CHAT_MODEL });
  assert.deepEqual(resolveChatModel({ AI_MODEL: "@cf/x/configured" }), { ok: true, model: "@cf/x/configured" });
  const scout = "@cf/meta/llama-4-scout-17b-16e-instruct";
  assert.deepEqual(resolveChatModel({}, scout), { ok: true, model: scout });
  assert.deepEqual(resolveChatModel({ AI_MODEL: "@cf/x/configured" }, "@cf/x/configured"), { ok: true, model: "@cf/x/configured" });
  const refused = resolveChatModel({}, "@cf/some/expensive-model");
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.allowed, [DEFAULT_CHAT_MODEL, scout]);
  const custom = resolveChatModel({ AI_MODEL_CHOICES: " @cf/a/one , @cf/b/two " }, "@cf/b/two");
  assert.deepEqual(custom, { ok: true, model: "@cf/b/two" });
  assert.equal(resolveChatModel({ AI_MODEL_CHOICES: "@cf/a/one" }, scout).ok, false, "a custom list replaces the default list");
});

test("chat wiring: the model calls echo_server_whoami and the echo server's whoami answers (over the binding)", async () => {
  clearSigningKeyCache();
  const enterprise = fakeEnterprise();
  const echoToken = await oboTokenForEcho();
  const { list, fetchImpl } = servers(enterprise.fetchImpl, true);
  const set = await McpServerSet.connect({ servers: list, fetchImpl, getToken: async (s) => (s.id === "echo" ? echoToken : "enterprise-token") });
  try {
    const modelTools = toolsForModel(set.tools);
    const offered: string[][] = [];
    let call = 0;
    const ai: AiBinding = {
      async run(_m, inputs) {
        offered.push(((inputs.tools as { name: string }[] | undefined) ?? []).map((t) => t.name));
        call++;
        if (call === 1) return { tool_calls: [{ name: "echo_server_whoami", arguments: {} }] };
        return { response: "The echo server sees the agent acting for Adele (agent-obo)." };
      },
    };
    const result = await runToolLoop({
      ai,
      model: "m",
      systemPrompt: buildSystemPrompt("Adele", modelTools),
      prompt: "Ask the echo server who is calling it",
      tools: modelTools,
      callTool: async (name, args) => toolResultToText((await set.callTool(routedToolName(modelTools, name), args)).result),
    });
    assert.deepEqual(offered[0], ["microsoft_graph_suggest_queries", "microsoft_graph_get", "echo_server_whoami", "echo_server_echo"]);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].ok, true);
    assert.match(result.toolCalls[0].preview, /"flow": "agent-obo"/);
    assert.equal(set.find(routedToolName(modelTools, result.toolCalls[0].tool))?.server, "echo");
    assert.equal(enterprise.seen.filter((r) => r.rpc === "tools/call").length, 0, "MCP Server for Enterprise was not called");
  } finally {
    await set.close();
  }
});
