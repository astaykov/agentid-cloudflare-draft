/**
 * The autonomous agent: a single Agent instance that wakes up on a schedule and
 * calls an MCP server with ITS OWN identity. No user is involved.
 *
 *   AUTH_MODE=agent-user  Leg 1 (T1) -> Leg 2 (T2, agent instance token) -> Leg 3 user_fic
 *                         => delegated token for the agent's own agent user
 *   AUTH_MODE=app-only    Leg 1 (T1) -> Leg 2 client_credentials
 *                         => application token for the agent identity
 */
import { Agent } from "agents";
import { runToolLoop, type ToolCallRecord } from "../shared/agent/tool-loop.ts";
import { ConfigurationError, splitList } from "../shared/config.ts";
import { TokenAcquisitionError } from "../shared/entra/agent-token-service.ts";
import { summarizeToken, type TokenSummary } from "../shared/entra/claims.ts";
import { getAgentTokenService } from "../shared/entra/token-service-factory.ts";
import { McpHttpError, McpRpcError, mcpFetcher, toolResultToText, withMcpClient } from "../shared/mcp/mcp-client.ts";
import type { AutonomousEnv } from "./env.ts";

export interface RunRecord {
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  mode: "agent-user" | "app-only";
  ok: boolean;
  token?: TokenSummary;
  tools?: string[];
  answer?: string;
  toolCalls?: ToolCallRecord[];
  toolResult?: string;
  error?: Record<string, unknown>;
}

interface AutonomousState {
  runs: RunRecord[];
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SYSTEM_PROMPT = `You are an autonomous agent that runs on a schedule with your own identity; no person is involved.
You call tools of an MCP server. Use as few tool calls as needed, then report the result in two or three sentences.
For Microsoft MCP Server for Enterprise: call microsoft_graph_suggest_queries to find a Microsoft Graph request, then microsoft_graph_get to run it.
Never invent data.`;

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof TokenAcquisitionError) return { type: "token_acquisition_failed", ...err.toJSON() };
  if (err instanceof McpHttpError) return { type: "mcp_http_error", status: err.status, message: err.message, wwwAuthenticate: err.wwwAuthenticate };
  if (err instanceof McpRpcError) return { type: "mcp_rpc_error", code: err.code, message: err.message };
  if (err instanceof ConfigurationError) return { type: "configuration_error", message: err.message };
  return { type: "error", message: err instanceof Error ? err.message : String(err) };
}

export class AutonomousAgent extends Agent<AutonomousEnv, AutonomousState> {
  initialState: AutonomousState = { runs: [] };
  /** The run in progress, if any (in memory: one Agent instance handles all runs). */
  private current?: { trigger: string; startedAt: string };

  private mode(): "agent-user" | "app-only" {
    const mode = (this.env.AUTH_MODE || "agent-user").toLowerCase();
    if (mode !== "agent-user" && mode !== "app-only") throw new ConfigurationError("AUTH_MODE must be agent-user or app-only");
    return mode;
  }

  /** The agent's own token for the MCP server. */
  private async ownToken(mode: "agent-user" | "app-only"): Promise<string> {
    const service = await getAgentTokenService(this.env);
    const scopes = splitList(this.env.MCP_SCOPES);
    if (mode === "app-only") return (await service.acquireAppToken(scopes)).accessToken;
    if (!this.env.AGENT_USER_ID && !this.env.AGENT_USER_UPN) {
      throw new ConfigurationError("AUTH_MODE=agent-user needs AGENT_USER_ID or AGENT_USER_UPN");
    }
    const result = await service.acquireAgentUserToken(scopes, {
      objectId: this.env.AGENT_USER_ID || undefined,
      userPrincipalName: this.env.AGENT_USER_UPN || undefined,
    });
    return result.accessToken;
  }

  /**
   * One run, started by an operator (POST /run) or by an optional Cron Trigger.
   * A second request while a run is in progress is refused (already_running) so a
   * double click does not spend tokens and Workers AI quota twice.
   * Records non-secret results in the agent's state.
   */
  async runJob(trigger: string): Promise<RunRecord> {
    const record: RunRecord = { trigger, startedAt: new Date().toISOString(), mode: "agent-user", ok: false };
    if (this.current) {
      record.error = { type: "already_running", message: `A run started at ${this.current.startedAt} (${this.current.trigger}) is still in progress` };
      record.finishedAt = record.startedAt;
      return record;
    }
    this.current = { trigger, startedAt: record.startedAt };
    try {
      return await this.execute(record);
    } finally {
      this.current = undefined;
    }
  }

  private async execute(record: RunRecord): Promise<RunRecord> {
    try {
      record.mode = this.mode();
      const accessToken = await this.ownToken(record.mode);
      record.token = summarizeToken(accessToken);

      await withMcpClient({ url: this.env.MCP_SERVER_URL, accessToken, fetchImpl: mcpFetcher(this.env.MCP_SERVICE) }, async (client) => {
        const tools = await client.listTools();
        record.tools = tools.map((t) => t.name);
        if (this.env.AI && this.env.JOB_PROMPT) {
          const result = await runToolLoop({
            ai: this.env.AI,
            model: this.env.AI_MODEL || DEFAULT_MODEL,
            systemPrompt: SYSTEM_PROMPT,
            prompt: this.env.JOB_PROMPT,
            tools,
            callTool: async (name, args) => toolResultToText(await client.callTool(name, args)),
          });
          record.answer = result.answer;
          record.toolCalls = result.toolCalls;
        } else if (this.env.JOB_TOOL) {
          let args: Record<string, unknown> = {};
          if (this.env.JOB_TOOL_ARGUMENTS) {
            try {
              args = JSON.parse(this.env.JOB_TOOL_ARGUMENTS);
            } catch {
              throw new ConfigurationError("JOB_TOOL_ARGUMENTS must be a JSON object");
            }
          }
          record.toolResult = toolResultToText(await client.callTool(this.env.JOB_TOOL, args), 4000);
        }
      });
      record.ok = true;
    } catch (err) {
      record.error = describeError(err);
      console.error(`Autonomous run failed: ${JSON.stringify(record.error)}`);
    }
    record.finishedAt = new Date().toISOString();
    this.setState({ runs: [record, ...this.state.runs].slice(0, 20) });
    return record;
  }

  async getStatus(): Promise<{ runs: RunRecord[] }> {
    return { runs: this.state.runs };
  }
}
