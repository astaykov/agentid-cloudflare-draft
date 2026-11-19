/**
 * Echo MCP server, dependency-free edition.
 *
 * Same tools and the same Entra Agent ID checks as the Cloudflare-native
 * edition in ../echo-mcp (Agents SDK + MCP TypeScript SDK), implemented as a
 * small stateless JSON-RPC handler for the Streamable HTTP transport. Use it
 * when your package mirror does not carry the MCP SDK, and in the local tests.
 */
import {
  auditLog,
  authenticateEchoCaller,
  echoPayload,
  echoResourceConfig,
  ECHO_INSTRUCTIONS,
  ECHO_SERVER_INFO,
  ECHO_TOOL,
  RateLimitedError,
  rateLimitedResponse,
  WHOAMI_TOOL,
  type EchoEnv,
} from "../echo-mcp/common.ts";
import type { AgentCaller } from "../shared/entra/agent-caller.ts";
import { TokenValidationError } from "../shared/entra/inbound-auth.ts";
import { isProtectedResourceMetadataPath, metadataResponse, tokenErrorResponse } from "../shared/mcp/protected-resource.ts";

export type { EchoEnv };

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const TOOLS = [
  {
    name: WHOAMI_TOOL.name,
    title: WHOAMI_TOOL.title,
    description: WHOAMI_TOOL.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: ECHO_TOOL.name,
    title: ECHO_TOOL.title,
    description: ECHO_TOOL.description,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: ECHO_TOOL.messageDescription } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function rpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function handleEchoRequest(request: Request, env: EchoEnv, deps: { fetchImpl?: typeof fetch } = {}): Promise<Response> {
  const url = new URL(request.url);
  const resource = echoResourceConfig(env);

  if (request.method === "GET" && url.pathname === "/") {
    return jsonResponse({ name: "Entra Agent ID echo MCP server (lite)", mcpEndpoint: `${url.origin}/mcp`, tools: TOOLS.map((t) => t.name) });
  }
  if (request.method === "GET" && isProtectedResourceMetadataPath(url.pathname)) return metadataResponse(url.origin, resource);
  if (url.pathname !== "/mcp") return jsonResponse({ error: "not_found" }, 404);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let caller: AgentCaller;
  try {
    caller = await authenticateEchoCaller(request, env, deps.fetchImpl);
  } catch (err) {
    if (err instanceof TokenValidationError) return tokenErrorResponse(err, url.origin, resource);
    if (err instanceof RateLimitedError) return rateLimitedResponse();
    throw err;
  }

  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message?.id, -32600, "Invalid request");
  if (message.id === undefined) return new Response(null, { status: 202 }); // notification

  switch (message.method) {
    case "initialize": {
      const requested = String(message.params?.protocolVersion ?? "");
      return rpcResult(message.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...ECHO_SERVER_INFO },
        instructions: ECHO_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      auditLog(caller, { tool: name, edition: "lite" });
      if (name === WHOAMI_TOOL.name) {
        return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(caller, null, 2) }], structuredContent: caller });
      }
      if (name === ECHO_TOOL.name) {
        if (typeof args.message !== "string") {
          return rpcResult(message.id, { content: [{ type: "text", text: "message (string) is required" }], isError: true });
        }
        const payload = echoPayload(args.message, caller);
        return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
      }
      return rpcError(message.id, -32602, `Unknown tool: ${name}`);
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}
