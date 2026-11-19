import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpHttpError, McpRpcError, toolResultToText, withMcpClient } from "../src/shared/mcp/mcp-client.ts";

type Call = { method: string; headers: Record<string, string>; body?: any };

function fakeServer(mode: "json" | "sse", opts: { status?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", headers, body });
    if (opts.status) {
      return new Response("unauthorized", {
        status: opts.status,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="audience mismatch"' },
      });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 405 });
    if (!body.id) return new Response(null, { status: 202 }); // notification
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
    else if (body.method === "tools/list") {
      result = body.params?.cursor
        ? { tools: [{ name: "b", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }], nextCursor: "page2" };
    } else if (body.method === "tools/call") {
      if (body.params.name === "boom") {
        const message = { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Unknown tool" } };
        return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
      }
      result = { content: [{ type: "text", text: `called ${body.params.name} with ${JSON.stringify(body.params.arguments)}` }] };
    }
    const message = { jsonrpc: "2.0", id: body.id, result };
    const responseHeaders: Record<string, string> = { "mcp-session-id": "session-123" };
    if (mode === "json") {
      return new Response(JSON.stringify(message), { headers: { ...responseHeaders, "content-type": "application/json" } });
    }
    // SSE: a progress notification first, then the response split across chunks.
    const progress = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`;
    const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(progress));
        controller.enqueue(encoder.encode(payload.slice(0, 20)));
        controller.enqueue(encoder.encode(payload.slice(20)));
        controller.close();
      },
    });
    return new Response(stream, { headers: { ...responseHeaders, "content-type": "text/event-stream" } });
  };
  return { calls, fetchImpl };
}

for (const mode of ["json", "sse"] as const) {
  test(`initialize, list (paged) and call tools over ${mode}`, async () => {
    const server = fakeServer(mode);
    const result = await withMcpClient({ url: "https://mcp.example/enterprise", accessToken: "tkn", fetchImpl: server.fetchImpl }, async (client) => {
      const tools = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
      return client.callTool("a", { q: 1 });
    });
    assert.equal(toolResultToText(result), 'called a with {"q":1}');
    // bearer on every request, session + protocol headers after initialize
    assert.ok(server.calls.every((c) => c.headers.authorization === "Bearer tkn"));
    assert.equal(server.calls[0].headers["mcp-session-id"], undefined);
    assert.equal(server.calls[1].body.method, "notifications/initialized");
    assert.equal(server.calls[1].headers["mcp-session-id"], "session-123");
    assert.equal(server.calls[1].headers["mcp-protocol-version"], "2025-03-26");
    assert.equal(server.calls.at(-1)!.method, "DELETE");
  });
}

test("surfaces HTTP 401 with the WWW-Authenticate challenge", async () => {
  const server = fakeServer("json", { status: 401 });
  const client = new McpClient({ url: "https://mcp.example/enterprise", accessToken: "bad", fetchImpl: server.fetchImpl });
  await assert.rejects(client.connect(), (err: unknown) => {
    assert.ok(err instanceof McpHttpError);
    assert.equal(err.status, 401);
    assert.match(err.wwwAuthenticate ?? "", /audience mismatch/);
    return true;
  });
});

test("surfaces JSON-RPC errors", async () => {
  const server = fakeServer("json");
  await assert.rejects(
    withMcpClient({ url: "https://mcp.example/enterprise", accessToken: "t", fetchImpl: server.fetchImpl }, (c) => c.callTool("boom")),
    (err: unknown) => err instanceof McpRpcError && err.code === -32602,
  );
});

test("toolResultToText truncates and falls back to structured content", () => {
  assert.equal(toolResultToText({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
  const long = toolResultToText({ content: [{ type: "text", text: "x".repeat(50) }] }, 10);
  assert.match(long, /truncated 40 characters/);
});
