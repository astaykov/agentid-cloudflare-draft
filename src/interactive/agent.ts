/**
 * The interactive agent: one Agent instance per signed-in user (named by the
 * user's object ID). Every instance shares the same Entra Agent ID; the
 * Durable Object only scopes conversation state to the user.
 *
 * Outbound: on-behalf-of the user, one token per MCP server:
 *   enterprise  Microsoft MCP Server for Enterprise (MCP_SERVER_URL, MCP_SCOPES)
 *   echo        the sample's echo MCP server on Cloudflare (ECHO_MCP_URL, ECHO_MCP_SCOPES), optional
 */
import { Agent } from "agents";
import { runToolLoop, type ChatMessage, type ToolCallRecord, type ToolLoopStep } from "../shared/agent/tool-loop.ts";
import { TokenAcquisitionError } from "../shared/entra/agent-token-service.ts";
import { summarizeToken } from "../shared/entra/claims.ts";
import { getAgentTokenService } from "../shared/entra/token-service-factory.ts";
import { McpHttpError, McpRpcError, toolResultToText, type McpServerInfo } from "../shared/mcp/mcp-client.ts";
import {
  McpServerSet,
  readMcpServers,
  UnknownToolError,
  type McpServerConfig,
  type McpServerProblem,
  type RoutedTool,
} from "../shared/mcp/mcp-servers.ts";
import { currentConversation, memoryMinutes, rememberTurn, type Conversation } from "./conversation.ts";
import type { InteractiveEnv } from "./env.ts";
import {
  buildSystemPrompt,
  INTERACTIVE_MCP_SERVERS,
  INTERACTIVE_SERVER_ORDER,
  resolveChatModel,
  routedToolName,
  toolsForModel,
  unavailableReason,
} from "./servers.ts";

export interface CallerInfo {
  oid: string;
  name?: string;
  clientId: string;
  scopes: string[];
}

interface InteractiveState {
  turns: number;
  history: ChatMessage[];
  lastActiveAt?: string;
}

/** Results cross the Durable Object RPC boundary as plain data, never as thrown custom errors. */
export type AgentResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: Record<string, unknown> };

/** One line per MCP server in /api/tools and in error answers. */
export interface ServerReport {
  id: string;
  url?: string;
  serverInfo?: McpServerInfo["serverInfo"];
  tools?: number;
  error?: Record<string, unknown>;
}

export type ChatToolCall = ToolCallRecord & { server?: string };

export interface ChatOptions {
  /** Forget the earlier turns before this question (CLI: chat --new). */
  newConversation?: boolean;
  /** Return what the model was offered and returned at each step (CLI: chat --debug). */
  debug?: boolean;
  /** A model from AI_MODEL_CHOICES for this request only (CLI: chat --model <id>). */
  model?: string;
}

export interface ChatAnswer {
  answer: string;
  /** The Workers AI model that answered. */
  model: string;
  toolCalls: ChatToolCall[];
  /** How much of the earlier conversation the model saw. */
  conversation: Pick<Conversation, "earlierTurns" | "startedFresh">;
  unavailableServers?: ServerReport[];
  /** Only with debug: one entry per model call. Never contains tokens. */
  trace?: ToolLoopStep[];
}

/** A plain-data description of an error (no tokens). */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof TokenAcquisitionError) return { type: "token_acquisition_failed", ...err.toJSON() };
  if (err instanceof McpHttpError) return { type: "mcp_http_error", status: err.status, message: err.message, wwwAuthenticate: err.wwwAuthenticate };
  if (err instanceof McpRpcError) return { type: "mcp_rpc_error", code: err.code, message: err.message };
  if (err instanceof UnknownToolError) return { type: "unknown_tool", message: err.message, available: err.available };
  return { type: "internal_error", message: err instanceof Error ? err.message : String(err) };
}

function failure(err: unknown): { ok: false; status: number; error: Record<string, unknown> } {
  const error = describeError(err);
  if (error.type === "unknown_tool") return { ok: false, status: 404, error };
  if (error.type === "internal_error") {
    console.error("Agent error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return { ok: false, status: 500, error };
  }
  return { ok: false, status: 502, error };
}

/** Per-server lines in configuration order: connected, failed, or misconfigured. */
export function serverReports(set: McpServerSet, problems: McpServerProblem[], order: string[]): ServerReport[] {
  const reports: ServerReport[] = [
    ...set.connections.map((c) => ({ id: c.server.id, url: c.server.url, serverInfo: c.info?.serverInfo, tools: c.tools.length })),
    ...set.failures.map((f) => ({ id: f.server.id, url: f.server.url, error: describeError(f.error) })),
    ...problems.map((p) => ({ id: p.id, error: { type: "configuration_error", message: p.message } })),
  ];
  return reports.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** No server could be reached: one server keeps its own error; several are listed. */
function noServer(set: McpServerSet, problems: McpServerProblem[]): { ok: false; status: number; error: Record<string, unknown> } {
  if (set.failures.length === 1 && problems.length === 0) return failure(set.failures[0].error);
  const servers = serverReports(set, problems, INTERACTIVE_SERVER_ORDER);
  const status = set.failures.length ? 502 : 500;
  return { ok: false, status, error: { type: "no_mcp_server_available", message: "No MCP server could be reached", servers } };
}

export class InteractiveAgent extends Agent<InteractiveEnv, InteractiveState> {
  initialState: InteractiveState = { turns: 0, history: [] };

  private configuredServers(): { servers: McpServerConfig[]; problems: McpServerProblem[] } {
    return readMcpServers(this.env, INTERACTIVE_MCP_SERVERS);
  }

  /**
   * Connects to the MCP servers, each with its own on-behalf-of token
   * (same agent identity, same user, audience = that server). Tokens never
   * leave this method's callers.
   */
  private async connect(userAssertion: string, options: { only?: string; listTools?: boolean } = {}) {
    const { servers, problems } = this.configuredServers();
    const selected = options.only ? servers.filter((s) => s.id === options.only) : servers;
    const service = await getAgentTokenService(this.env);
    const set = await McpServerSet.connect({
      servers: selected,
      getToken: async (server) => (await service.acquireTokenOnBehalfOf(userAssertion, server.scopes)).accessToken,
      listTools: options.listTools,
      clientName: "agentid-cf-interactive",
    });
    return { set, problems: options.only ? problems.filter((p) => p.id === options.only) : problems };
  }

  /**
   * Shows the identity chain without calling an MCP server: the inbound user
   * token, T1 (blueprint -> agent identity) and one OBO token per MCP server.
   */
  async whoami(userAssertion: string, caller: CallerInfo): Promise<AgentResult<Record<string, unknown>>> {
    try {
      const service = await getAgentTokenService(this.env);
      const t1 = await service.acquireFmiCredential();
      const { servers, problems } = this.configuredServers();
      const onBehalfOf: Record<string, unknown> = {};
      for (const server of servers) {
        try {
          const result = await service.acquireTokenOnBehalfOf(userAssertion, server.scopes);
          onBehalfOf[server.id] = summarizeToken(result.accessToken);
        } catch (err) {
          onBehalfOf[server.id] = { error: describeError(err) };
        }
      }
      for (const problem of problems) onBehalfOf[problem.id] = { error: { type: "configuration_error", message: problem.message } };
      return {
        ok: true,
        caller,
        agent: {
          blueprintClientId: service.config.blueprintClientId,
          agentIdentityId: service.config.agentIdentityId,
          certificateThumbprintSha1: service.certificate.thumbprintSha1Hex,
          instance: this.name,
        },
        tokens: {
          inbound: summarizeToken(userAssertion),
          leg1_fmi_credential: summarizeToken(t1),
          leg2_on_behalf_of: onBehalfOf,
        },
        note: "Claims only. Tokens are never returned or logged. One on-behalf-of token per MCP server: same azp (agent identity) and oid (you), different aud and scp.",
      };
    } catch (err) {
      return failure(err);
    }
  }

  async listTools(userAssertion: string): Promise<AgentResult<{ servers: ServerReport[]; tools: RoutedTool[] }>> {
    try {
      const { set, problems } = await this.connect(userAssertion);
      try {
        if (!set.connections.length) return noServer(set, problems);
        return { ok: true, servers: serverReports(set, problems, INTERACTIVE_SERVER_ORDER), tools: set.tools };
      } finally {
        await set.close();
      }
    } catch (err) {
      return failure(err);
    }
  }

  /**
   * Deterministic tool call, no LLM: handy to test permissions. With `server`,
   * the call goes to that server only; without it, the tool name decides.
   */
  async callTool(
    userAssertion: string,
    name: string,
    args: Record<string, unknown>,
    server?: string,
  ): Promise<AgentResult<{ server: string; tool: string; result: unknown }>> {
    try {
      const { servers, problems } = this.configuredServers();
      if (server && !servers.some((s) => s.id === server)) {
        const problem = problems.find((p) => p.id === server);
        return {
          ok: false,
          status: problem ? 500 : 404,
          error: problem
            ? { type: "configuration_error", message: problem.message }
            : { type: "unknown_server", message: `No MCP server '${server}' is configured`, configured: servers.map((s) => s.id) },
        };
      }
      // One server (or an explicit one): call straight away. Several: list tools to find the owner.
      const only = server ?? (servers.length === 1 ? servers[0].id : undefined);
      const { set, problems: selectedProblems } = await this.connect(userAssertion, { only, listTools: !only });
      try {
        if (!set.connections.length) return noServer(set, selectedProblems);
        const call = await set.callTool(name, args, only);
        return { ok: true, server: call.server, tool: call.tool, result: call.result };
      } catch (err) {
        if (err instanceof UnknownToolError && set.failures.length) {
          const servers = serverReports(set, selectedProblems, INTERACTIVE_SERVER_ORDER);
          return { ok: false, status: 404, error: { ...describeError(err), servers } };
        }
        throw err;
      } finally {
        await set.close();
      }
    } catch (err) {
      return failure(err);
    }
  }

  async chat(userAssertion: string, caller: CallerInfo, prompt: string, options: ChatOptions = {}): Promise<AgentResult<ChatAnswer>> {
    const ai = this.env.AI;
    if (!ai) return { ok: false, status: 501, error: { type: "ai_not_configured", message: "Add the Workers AI binding (\"ai\") to enable /api/chat." } };
    if (!prompt.trim()) return { ok: false, status: 400, error: { type: "invalid_request", message: "prompt is required" } };
    const chosen = resolveChatModel(this.env, options.model);
    if (!chosen.ok) {
      return {
        ok: false,
        status: 400,
        error: { type: "invalid_request", message: `Model '${options.model}' is not allowed here (AI_MODEL_CHOICES)`, allowed: chosen.allowed },
      };
    }
    try {
      const { set, problems } = await this.connect(userAssertion);
      try {
        if (!set.connections.length) return noServer(set, problems);
        // Earlier turns only while the conversation is fresh (CHAT_MEMORY_MINUTES) and not reset.
        const conversation = currentConversation(this.state, {
          now: Date.now(),
          minutes: memoryMinutes(this.env.CHAT_MEMORY_MINUTES),
          newConversation: options.newConversation,
        });
        const unavailable = serverReports(set, problems, INTERACTIVE_SERVER_ORDER).filter((s) => s.error);
        const model = chosen.model;
        // The model sees which server each tool belongs to (in the description, and in the name for
        // the echo server) and which servers failed; it never sees a token.
        const modelTools = toolsForModel(set.tools);
        const result = await runToolLoop({
          ai,
          model,
          systemPrompt: buildSystemPrompt(
            caller.name,
            modelTools,
            unavailable.map((s) => ({ id: s.id, reason: unavailableReason(s.error) })),
          ),
          history: conversation.history,
          prompt: prompt.slice(0, 4000),
          tools: modelTools,
          callTool: async (name, args) => toolResultToText((await set.callTool(routedToolName(modelTools, name), args)).result),
        });
        // Reported under the server's own tool names (echo/whoami), as `tools` and `call` use them.
        const toolCalls: ChatToolCall[] = result.toolCalls.map((call) => {
          const owner = set.find(routedToolName(modelTools, call.tool));
          return { ...call, tool: owner?.name ?? call.tool, server: owner?.server };
        });
        // Only answered turns are remembered; an unanswered one would come back as an open question.
        const history = result.completed ? rememberTurn(conversation.history, prompt, result.answer) : conversation.history;
        this.setState({ turns: this.state.turns + 1, history, lastActiveAt: new Date().toISOString() });
        return {
          ok: true,
          answer: result.answer,
          model,
          toolCalls,
          conversation: {
            earlierTurns: conversation.earlierTurns,
            ...(conversation.startedFresh ? { startedFresh: conversation.startedFresh } : {}),
          },
          ...(unavailable.length ? { unavailableServers: unavailable } : {}),
          ...(options.debug ? { trace: result.trace } : {}),
        };
      } finally {
        await set.close();
      }
    } catch (err) {
      return failure(err);
    }
  }

  async reset(): Promise<AgentResult<{ cleared: boolean }>> {
    this.setState({ turns: 0, history: [] });
    return { ok: true, cleared: true };
  }
}
