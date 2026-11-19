/**
 * The interactive agent's MCP servers and the system prompt built from their
 * tools. No package imports, so the Node tests use it directly.
 *
 *   enterprise  Microsoft MCP Server for Enterprise (MCP_SERVER_URL, MCP_SCOPES, MCP_SERVICE)
 *   echo        the sample's echo MCP server on Cloudflare (ECHO_MCP_URL, ECHO_MCP_SCOPES, ECHO_MCP_SERVICE), optional
 *
 * The agent asks Entra for one on-behalf-of token per server: same agent identity
 * (azp) and same user (oid) in each, but each with its own audience and scopes.
 */
import type { McpServerSlot, RoutedTool } from "../shared/mcp/mcp-servers.ts";

/** The chat model unless AI_MODEL says otherwise. */
export const DEFAULT_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/**
 * Models `chat --model` may pick when AI_MODEL_CHOICES is not set. Both have function calling on
 * Workers AI and return the same output format (response, tool_calls, usage).
 */
export const DEFAULT_MODEL_CHOICES = [DEFAULT_CHAT_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct"];

/**
 * The model for one chat request: AI_MODEL, or a requested one from AI_MODEL_CHOICES
 * (comma-separated; default DEFAULT_MODEL_CHOICES). The allow-list keeps a signed-in user from
 * choosing any (possibly expensive) model.
 */
export function resolveChatModel(
  env: { AI_MODEL?: string; AI_MODEL_CHOICES?: string },
  requested?: string,
): { ok: true; model: string } | { ok: false; allowed: string[] } {
  const configured = env.AI_MODEL?.trim() || DEFAULT_CHAT_MODEL;
  if (!requested?.trim()) return { ok: true, model: configured };
  const listed = (env.AI_MODEL_CHOICES ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const allowed = [...new Set([configured, ...(listed.length ? listed : DEFAULT_MODEL_CHOICES)])];
  const model = requested.trim();
  return allowed.includes(model) ? { ok: true, model } : { ok: false, allowed };
}

/**
 * Tool names as the MODEL sees them, per server. MCP Server for Enterprise's names already say
 * what they are (microsoft_graph_get). The echo server's are whoami and echo: asked about "the
 * echo server", Llama 3.3 reached for the tool named echo (which needs a message) and asked for
 * more details instead of calling whoami. echo_server_whoami / echo_server_echo leave no doubt.
 * Only the model sees these names; calls go to the server under its own tool names.
 */
export const MODEL_TOOL_PREFIX: Readonly<Record<string, string>> = { echo: "echo_server_" };

/** A tool as offered to the model: its model-facing name, and the routed name used for the call. */
export interface ModelTool extends RoutedTool {
  routedName: string;
}

/** The routed name (what McpServerSet.callTool takes) for a tool name the model used. */
export function routedToolName(modelTools: ModelTool[], name: string): string {
  return modelTools.find((t) => t.name === name)?.routedName ?? name;
}

/** In the order they are listed and offered to the model. */
export const INTERACTIVE_MCP_SERVERS: McpServerSlot[] = [
  { id: "enterprise", urlVar: "MCP_SERVER_URL", scopesVar: "MCP_SCOPES", serviceVar: "MCP_SERVICE", required: true },
  { id: "echo", urlVar: "ECHO_MCP_URL", scopesVar: "ECHO_MCP_SCOPES", serviceVar: "ECHO_MCP_SERVICE", scopeExample: "api://<echo app id>/Echo.Read" },
];

export const INTERACTIVE_SERVER_ORDER = INTERACTIVE_MCP_SERVERS.map((s) => s.id);

/**
 * Tools as the model sees them: descriptions start with the server they belong to, and servers
 * in MODEL_TOOL_PREFIX get names that carry the server (echo_server_whoami). A prefixed name that
 * would clash with another tool keeps the routed name.
 */
export function toolsForModel(tools: RoutedTool[]): ModelTool[] {
  const routedNames = new Set(tools.map((t) => t.name));
  const used = new Set<string>();
  return tools.map((t) => {
    const prefix = MODEL_TOOL_PREFIX[t.server];
    const wanted = prefix ? `${prefix}${t.originalName}` : t.name;
    const name = wanted !== t.name && (routedNames.has(wanted) || used.has(wanted)) ? t.name : wanted;
    used.add(name);
    return { ...t, name, routedName: t.name, description: `[${t.server} MCP server] ${t.description ?? t.title ?? t.originalName}` };
  });
}

/** A configured MCP server that could not be used for this request. */
export interface UnavailableServer {
  id: string;
  reason: string;
}

/** A short, token-free reason from a ServerReport error (type, HTTP status, AADSTS code, message). */
export function unavailableReason(error: Record<string, unknown> | undefined): string {
  if (!error) return "unknown error";
  const parts = [error.type, error.status && `HTTP ${error.status}`, error.aadsts, error.message].filter(Boolean).map(String);
  const text = parts.join(": ").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

/**
 * Built per request from the tools that are actually available. Servers that failed are
 * named with their reason, so the model reports them instead of guessing a tool name or
 * answering something else with another server's tools.
 */
export function buildSystemPrompt(callerName: string | undefined, tools: RoutedTool[], unavailable: UnavailableServer[] = []): string {
  const lines = [
    "You are an assistant for the signed-in user. You call tools of MCP servers; every call runs with the user's delegated permissions.",
    "Each tool description starts with the server it belongs to, for example [enterprise MCP server].",
    "Earlier messages of this conversation are context only: answer the user's latest message, never an earlier question again.",
  ];
  const named = (original: string, server?: string) =>
    tools.find((t) => t.originalName === original && (server === undefined || t.server === server))?.name;
  const suggest = named("microsoft_graph_suggest_queries");
  const graphGet = named("microsoft_graph_get");
  if (suggest && graphGet) {
    lines.push(
      `For a question about the user's Microsoft Entra tenant: call ${suggest} first to find the right Microsoft Graph request, then call ${graphGet} to run it.`,
    );
  }
  const whoami = named("whoami", "echo");
  const echo = named("echo", "echo");
  if (whoami || echo) {
    lines.push(
      "The echo MCP server is the sample's own MCP server on Cloudflare." +
        (whoami ? ` Its ${whoami} tool returns how that server sees the caller: the Agent ID flow, the agent identity, its blueprint and the user.` : "") +
        (echo ? ` Its ${echo} tool repeats a text the user gives.` : "") +
        " Use these tools when the user asks about the echo server, what it sees, who is calling it, or asks to echo something.",
    );
    if (whoami) {
      lines.push(
        `To find out who is calling the echo server or what it sees, call ${whoami} with empty arguments {}. ` +
          "Questions about the echo server need no further details from the user.",
      );
    }
    if (echo) lines.push(`Call ${echo} only when the user gives a text to echo.`);
  }
  for (const server of unavailable) {
    lines.push(
      `The ${server.id} MCP server is configured but not available for this request, so it has no tools now. Reason: ${server.reason}. ` +
        `If the user asks for the ${server.id} MCP server, say that it is not available and give this reason; do not use another server's tools instead.`,
    );
  }
  lines.push("Use only the tools you are given; never guess a tool name. Answer briefly and only from tool results. If a tool fails, say what failed. Never invent data.");
  lines.push(`The signed-in user is ${callerName ?? "unknown"}.`);
  return lines.join("\n");
}
