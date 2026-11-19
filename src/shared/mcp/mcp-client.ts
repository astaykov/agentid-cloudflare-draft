/**
 * Minimal MCP client for the Streamable HTTP transport (MCP spec 2025-03-26 /
 * 2025-06-18): initialize -> notifications/initialized -> tools/list | tools/call.
 *
 * Why not @modelcontextprotocol/sdk? Its client compiles tool output schemas
 * with Ajv, which generates code at runtime (`new Function`), and Workers
 * forbid that. This client is ~200 lines, has no dependencies, and handles the
 * two response styles servers use: a JSON body or an SSE stream.
 *
 * The bearer token is attached to every request and never logged.
 */
import { withHostHeader } from "../host-header.ts";

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerInfo {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

/** HTTP-level failure, e.g. 401 when the MCP server rejects the token. */
export class McpHttpError extends Error {
  readonly status: number;
  /** The server's WWW-Authenticate challenge: tells you why a token was rejected. */
  readonly wwwAuthenticate?: string;
  constructor(status: number, message: string, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** JSON-RPC error returned by the server. */
export class McpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export interface McpClientOptions {
  url: string;
  accessToken: string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class McpClient {
  private readonly options: McpClientOptions;
  private readonly fetchImpl: typeof fetch;
  private sessionId?: string;
  private protocolVersion?: string;
  private nextId = 1;
  server?: McpServerInfo;

  constructor(options: McpClientOptions) {
    this.options = options;
    const f = options.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => f(input, init);
  }

  async connect(): Promise<McpServerInfo> {
    const result = (await this.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.options.clientName ?? "agentid-cloudflare", version: this.options.clientVersion ?? "1.0.0" },
    })) as McpServerInfo;
    if (!KNOWN_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new McpRpcError(-32602, `Unsupported MCP protocol version '${result.protocolVersion}'`);
    }
    this.protocolVersion = result.protocolVersion;
    this.server = result;
    await this.notify("notifications/initialized");
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
  }

  /** Ends the session (servers may answer 405; that is fine). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.options.url, { method: "DELETE", headers: this.headers() });
    } catch {
      // best effort
    }
    this.sessionId = undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  private async post(body: unknown): Promise<Response> {
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new McpHttpError(
        response.status,
        `MCP server returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        response.headers.get("www-authenticate") ?? undefined,
      );
    }
    return response;
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    await response.body?.cancel();
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const contentType = response.headers.get("content-type") ?? "";
    const message = contentType.includes("text/event-stream")
      ? await readSseResponse(response, id)
      : ((await response.json()) as JsonRpcResponse);
    if (!message || message.id !== id) throw new McpRpcError(-32603, `No response to '${method}' from MCP server`);
    if (message.error) throw new McpRpcError(message.error.code, message.error.message, message.error.data);
    return message.result;
  }
}

/** Reads SSE events until the JSON-RPC response with the given id arrives. */
async function readSseResponse(response: Response, id: number): Promise<JsonRpcResponse | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleEvent = (event: string): JsonRpcResponse | undefined => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return undefined;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      return messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const found = handleEvent(event);
        if (found) return found;
      }
      if (done) return handleEvent(buffer);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Runs `fn` against a connected client and always closes the session. */
/**
 * Optional Cloudflare service binding to the MCP server's Worker: the request
 * goes Worker-to-Worker without a public hop, still carrying the Entra token,
 * which the MCP server validates as usual. (Zone features such as WAF or API
 * Shield do not run on this path, so the server must validate the token itself.)
 *
 * Such a request has no Host header unless the caller sets one, and MCP handlers
 * that check Host (createMcpHandler on workers.dev) refuse it with 403 "Missing
 * Host header". mcpFetcher therefore sends the Host of the server's URL, as the
 * public path would (see ../host-header.ts).
 */
export interface ServiceBindingLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function mcpFetcher(binding: ServiceBindingLike | undefined): typeof fetch | undefined {
  if (!binding) return undefined;
  return (input, init) => binding.fetch(withHostHeader(new Request(input as RequestInfo | URL, init)));
}

export async function withMcpClient<T>(options: McpClientOptions, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = new McpClient(options);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Flattens a tool result into text for an LLM or a log, capped in size. */
export function toolResultToText(result: McpToolResult, maxChars = 12_000): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && typeof (item.resource as { text?: unknown })?.text === "string") {
      parts.push(String((item.resource as { text: string }).text));
    } else parts.push(`[${item.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} characters]` : text;
}
