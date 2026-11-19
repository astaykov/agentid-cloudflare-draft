/**
 * Several MCP servers behind one agent.
 *
 * Each MCP server is its own resource in Microsoft Entra ID, so the agent asks
 * for a separate token per server. With on-behalf-of, every token has the same
 * agent identity (azp) and the same user (oid), but its own audience (aud) and
 * scopes (scp). A server that fails (no consent, wrong audience, offline) is
 * reported on its own and does not take the other servers down.
 *
 * No package imports, so the Node tests run it as is.
 */
import { McpClient, mcpFetcher, type McpServerInfo, type McpTool, type McpToolResult, type ServiceBindingLike } from "./mcp-client.ts";

export interface McpServerConfig {
  /** Short label for tool lists, tool-call records and the CLI's --server option. */
  id: string;
  /** Public Streamable HTTP endpoint. Also the URL used over a service binding. */
  url: string;
  /** Scopes requested from Microsoft Entra ID for this server. */
  scopes: string[];
  /** Optional service binding to the server's Worker (no public hop; the token is still sent). */
  service?: ServiceBindingLike;
}

/** Where one server's settings live in the Worker's environment. */
export interface McpServerSlot {
  id: string;
  urlVar: string;
  scopesVar: string;
  serviceVar?: string;
  /** Required slots report a problem when their URL is empty; optional ones are simply off. */
  required?: boolean;
  /** Example scope for the error message, e.g. api://<echo app id>/Echo.Read */
  scopeExample?: string;
}

/** A server whose configuration is incomplete. Reported per server, never thrown. */
export interface McpServerProblem {
  id: string;
  message: string;
}

function splitScopes(value: unknown): string[] {
  return typeof value === "string" ? value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : [];
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Reads the configured MCP servers from the environment. A slot with an empty
 * URL is off (or a problem, when required). A slot with a URL but no scopes, or
 * an invalid URL, becomes a problem; the other servers are unaffected.
 */
export function readMcpServers(env: object, slots: McpServerSlot[]): { servers: McpServerConfig[]; problems: McpServerProblem[] } {
  const values = env as Record<string, unknown>;
  const servers: McpServerConfig[] = [];
  const problems: McpServerProblem[] = [];
  for (const slot of slots) {
    const rawUrl = typeof values[slot.urlVar] === "string" ? (values[slot.urlVar] as string).trim() : "";
    if (!rawUrl) {
      if (slot.required) problems.push({ id: slot.id, message: `${slot.urlVar} is not set` });
      continue;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      problems.push({ id: slot.id, message: `${slot.urlVar} is not a valid URL` });
      continue;
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
      problems.push({ id: slot.id, message: `${slot.urlVar} must be an https:// URL (http:// only for localhost)` });
      continue;
    }
    const scopes = splitScopes(values[slot.scopesVar]);
    if (!scopes.length) {
      const example = slot.scopeExample ? `, for example ${slot.scopeExample}` : "";
      problems.push({ id: slot.id, message: `${slot.scopesVar} is not set${example}` });
      continue;
    }
    const binding = slot.serviceVar ? values[slot.serviceVar] : undefined;
    const service = binding && typeof (binding as ServiceBindingLike).fetch === "function" ? (binding as ServiceBindingLike) : undefined;
    servers.push({ id: slot.id, url: url.toString(), scopes, ...(service ? { service } : {}) });
  }
  return { servers, problems };
}

/** A tool as the agent offers it: unique name across all servers, plus where it lives. */
export interface RoutedTool extends McpTool {
  /** Id of the server that has the tool. */
  server: string;
  /** The tool's name on that server (differs from `name` only when two servers use the same name). */
  originalName: string;
}

export interface McpConnection {
  server: McpServerConfig;
  client: McpClient;
  info?: McpServerInfo;
  tools: McpTool[];
}

export interface McpServerFailure {
  server: McpServerConfig;
  error: unknown;
}

export interface ConnectMcpServersOptions {
  servers: McpServerConfig[];
  /** Returns the access token for one server (OBO, app-only, agent user). Failures stay with that server. */
  getToken: (server: McpServerConfig) => Promise<string>;
  /** Default true. False skips tools/list (a direct call to a known server and tool). */
  listTools?: boolean;
  /** Used when a server has no service binding (tests pass a fake). */
  fetchImpl?: typeof fetch;
  clientName?: string;
  requestTimeoutMs?: number;
}

/**
 * Gives tools unique names: a name used by one server stays as is; a name used
 * by several servers becomes "<server id>_<name>" for each of them.
 */
export function routeTools(connections: { server: { id: string }; tools: McpTool[] }[]): RoutedTool[] {
  const counts = new Map<string, number>();
  for (const connection of connections) {
    for (const tool of connection.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  const routed: RoutedTool[] = [];
  for (const connection of connections) {
    for (const tool of connection.tools) {
      const name = (counts.get(tool.name) ?? 0) > 1 ? `${connection.server.id}_${tool.name}` : tool.name;
      routed.push({ ...tool, name, server: connection.server.id, originalName: tool.name });
    }
  }
  return routed;
}

export class UnknownToolError extends Error {
  readonly tool: string;
  readonly available: string[];
  constructor(tool: string, available: string[]) {
    super(`No connected MCP server has a tool named '${tool}'`);
    this.name = "UnknownToolError";
    this.tool = tool;
    this.available = available;
  }
}

/** Connected MCP servers for one request. Always call close(). */
export class McpServerSet {
  readonly connections: McpConnection[];
  readonly failures: McpServerFailure[];
  readonly tools: RoutedTool[];

  private constructor(connections: McpConnection[], failures: McpServerFailure[]) {
    this.connections = connections;
    this.failures = failures;
    this.tools = routeTools(connections);
  }

  /** Connects to every server in parallel; a failing server ends up in `failures`. */
  static async connect(options: ConnectMcpServersOptions): Promise<McpServerSet> {
    const settled = await Promise.allSettled(
      options.servers.map(async (server): Promise<McpConnection> => {
        const accessToken = await options.getToken(server);
        const client = new McpClient({
          url: server.url,
          accessToken,
          fetchImpl: mcpFetcher(server.service) ?? options.fetchImpl,
          clientName: options.clientName,
          requestTimeoutMs: options.requestTimeoutMs,
        });
        try {
          const info = await client.connect();
          const tools = options.listTools === false ? [] : await client.listTools();
          return { server, client, info, tools };
        } catch (err) {
          await client.close();
          throw err;
        }
      }),
    );
    const connections: McpConnection[] = [];
    const failures: McpServerFailure[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") connections.push(outcome.value);
      else failures.push({ server: options.servers[index], error: outcome.reason });
    });
    return new McpServerSet(connections, failures);
  }

  /** Finds a tool by the name the agent offers it under, or by server id + the server's own tool name. */
  find(name: string, serverId?: string): RoutedTool | undefined {
    if (serverId) return this.tools.find((t) => t.server === serverId && (t.originalName === name || t.name === name));
    return this.tools.find((t) => t.name === name);
  }

  connection(serverId: string): McpConnection | undefined {
    return this.connections.find((c) => c.server.id === serverId);
  }

  /**
   * Calls a tool. With a server id, the call goes straight to that server under
   * the server's own tool name (no tools/list needed); otherwise the name is
   * looked up in the routed tool list.
   */
  async callTool(name: string, args: Record<string, unknown>, serverId?: string): Promise<{ server: string; tool: string; result: McpToolResult }> {
    if (serverId) {
      const connection = this.connection(serverId);
      if (!connection) throw new UnknownToolError(name, this.tools.map((t) => t.name));
      const tool = this.find(name, serverId);
      const toolName = tool?.originalName ?? name;
      return { server: serverId, tool: toolName, result: await connection.client.callTool(toolName, args) };
    }
    const tool = this.find(name);
    if (!tool) throw new UnknownToolError(name, this.tools.map((t) => t.name));
    const connection = this.connection(tool.server)!;
    return { server: tool.server, tool: tool.originalName, result: await connection.client.callTool(tool.originalName, args) };
  }

  /** Ends every MCP session (best effort). */
  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.client.close()));
  }
}
