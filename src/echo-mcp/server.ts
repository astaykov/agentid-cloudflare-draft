/**
 * Echo MCP server, Cloudflare-native edition: the tools.
 *
 * Built with the MCP TypeScript SDK v2 (`McpServer` from @modelcontextprotocol/server)
 * and served by the Agents SDK's stateless `createMcpHandler` (see index.ts),
 * which builds one server per request from this factory.
 *
 * Tool handlers read the authenticated caller with `getMcpAuthContext()`. The
 * Agents SDK fills it from `ctx.props`, which `OAuthResourceServer` sets from
 * the result of our Entra Agent ID check. The token itself never reaches a tool.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { AgentCaller } from "../shared/entra/agent-caller.ts";
import { auditLog, echoPayload, ECHO_INSTRUCTIONS, ECHO_SERVER_INFO, ECHO_TOOL, WHOAMI_TOOL } from "./common.ts";

function currentCaller(): AgentCaller {
  const caller = getMcpAuthContext()?.props?.caller as AgentCaller | undefined;
  if (!caller) {
    // Only reachable if createMcpHandler is wired without the resource guard in index.ts.
    throw new Error("No authenticated caller: the MCP handler must run behind OAuthResourceServer");
  }
  return caller;
}

/** Server factory for createMcpHandler (one server per request). */
export function createEchoServer(): McpServer {
  const server = new McpServer(
    { name: ECHO_SERVER_INFO.name, version: ECHO_SERVER_INFO.version },
    { instructions: ECHO_INSTRUCTIONS },
  );

  server.registerTool(
    WHOAMI_TOOL.name,
    {
      title: WHOAMI_TOOL.title,
      description: WHOAMI_TOOL.description,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, context) => {
      const caller = currentCaller();
      auditLog(caller, { tool: WHOAMI_TOOL.name, edition: "cloudflare-native" });
      // What OAuthResourceServer verified about the token (ctx.auth), as the MCP SDK hands it to tools.
      const authInfo = context.http?.authInfo;
      const result = {
        ...caller,
        verifiedByCloudflare: { clientId: authInfo?.clientId, scopes: authInfo?.scopes, expiresAt: authInfo?.expiresAt },
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  );

  server.registerTool(
    ECHO_TOOL.name,
    {
      title: ECHO_TOOL.title,
      description: ECHO_TOOL.description,
      inputSchema: z.object({ message: z.string().describe(ECHO_TOOL.messageDescription) }),
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => {
      const caller = currentCaller();
      auditLog(caller, { tool: ECHO_TOOL.name, edition: "cloudflare-native" });
      const payload = echoPayload(message, caller);
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
    },
  );

  return server;
}
