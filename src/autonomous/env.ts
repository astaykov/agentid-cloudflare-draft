import type { AgentIdentityEnv } from "../shared/config.ts";
import type { AiBinding } from "../shared/agent/tool-loop.ts";
import type { AutonomousAgent } from "./agent.ts";

export interface AutonomousEnv extends AgentIdentityEnv {
  AUTONOMOUS_AGENT: DurableObjectNamespace<AutonomousAgent>;
  AI?: AiBinding;
  /**
   * "agent-user" (default): the agent's own agent user, delegated token via user_fic.
   *   Required for Microsoft MCP Server for Enterprise, which accepts delegated tokens only.
   * "app-only": the agent identity's own app token (client credentials), for MCP
   *   servers that accept application permissions (e.g. the echo MCP server in this repo).
   */
  AUTH_MODE?: string;
  /** Agent user for "agent-user" mode: UPN or object ID (object ID wins). */
  AGENT_USER_UPN?: string;
  AGENT_USER_ID?: string;
  MCP_SERVER_URL: string;
  /** e.g. "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default" */
  MCP_SCOPES: string;
  /** What the job does on each run. With Workers AI: a prompt; without: one tool call. */
  JOB_PROMPT?: string;
  JOB_TOOL?: string;
  JOB_TOOL_ARGUMENTS?: string;
  AI_MODEL?: string;
  /**
   * How /status and /run are protected:
   *   "admin-key" (default): header x-admin-key must match the ADMIN_KEY secret.
   *   "access": Cloudflare Access in front of this Worker (operators sign in with
   *             Entra ID, automation uses an Access service token); the Worker
   *             checks the platform-validated ctx.access and its audience tag.
   */
  ADMIN_AUTH?: string;
  /** Audience (AUD) tag of the Access application that protects this Worker. Required for ADMIN_AUTH=access. */
  ACCESS_AUD?: string;
  /** Secret. Protects /status and /run in admin-key mode. If unset, both endpoints are disabled. */
  ADMIN_KEY?: string;
  /** Optional service binding to an MCP server Worker (e.g. the echo MCP server): private path, same Entra token. */
  MCP_SERVICE?: Fetcher;
}
