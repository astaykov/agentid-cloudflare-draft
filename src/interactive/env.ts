import type { AgentIdentityEnv } from "../shared/config.ts";
import type { AiBinding } from "../shared/agent/tool-loop.ts";
import type { InteractiveAgent } from "./agent.ts";

export interface InteractiveEnv extends AgentIdentityEnv {
  /** One Agent (Durable Object) instance per signed-in user. */
  INTERACTIVE_AGENT: DurableObjectNamespace<InteractiveAgent>;
  /** Workers AI. Optional: without it /api/chat is disabled, the other endpoints still work. */
  AI?: AiBinding;
  /** Delegated scope(s) the caller's token must carry. Default: access_agent. */
  INBOUND_REQUIRED_SCOPES?: string;
  /** Optional allow-list of client app IDs (azp) that may call the agent. */
  INBOUND_ALLOWED_CLIENT_IDS?: string;
  /** Downstream MCP server and the scope(s) requested on-behalf-of the user. */
  MCP_SERVER_URL: string;
  MCP_SCOPES: string;
  /** Workers AI model with function calling. */
  AI_MODEL?: string;
  /**
   * Models a chat request may pick with "model" (CLI: chat --model <id>), comma-separated.
   * Default: Llama 3.3 70B and Llama 4 Scout. AI_MODEL is always allowed.
   */
  AI_MODEL_CHOICES?: string;
  /**
   * Minutes without a chat message after which /api/chat starts a new conversation (the
   * earlier turns are no longer sent to the model). Default 30; 0 = every message stands alone.
   */
  CHAT_MEMORY_MINUTES?: string;
  /** Optional service binding to the MCP_SERVER_URL server's Worker: private path, same Entra token. */
  MCP_SERVICE?: Fetcher;
  /**
   * Optional second MCP server: the echo MCP server (workers/echo-mcp or echo-mcp-lite), called
   * on-behalf-of the same user with its own token. Empty = off. Example:
   * https://agentid-cf-echo-mcp.<subdomain>.workers.dev/mcp
   */
  ECHO_MCP_URL?: string;
  /** Scope(s) for the echo MCP server, e.g. api://<echo app id>/Echo.Read (npm run entra:setup prints it). */
  ECHO_MCP_SCOPES?: string;
  /** Optional service binding to the echo MCP server Worker: private path, same Entra token. */
  ECHO_MCP_SERVICE?: Fetcher;
}
