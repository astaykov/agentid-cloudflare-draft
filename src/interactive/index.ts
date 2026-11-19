/**
 * Interactive agent Worker.
 *
 *  Client --(user token, aud = blueprint)--> Worker: validate -> Agent instance (per user)
 *  Agent  --(OBO token, agent identity acting for the user)--> MCP Server for Enterprise
 *  Agent  --(second OBO token, aud = echo app)--> echo MCP server on Cloudflare (optional)
 *
 * Inbound authorization happens HERE, before any Agent instance is touched,
 * as Cloudflare recommends for Durable Objects.
 */
import { getAgentByName } from "agents";
import { splitList } from "../shared/config.ts";
import { EntraTokenValidator } from "../shared/entra/inbound-auth.ts";
import { getAgentTokenService } from "../shared/entra/token-service-factory.ts";
import { errorResponse, HttpError, json, readJsonBody } from "../shared/http.ts";
import { readMcpServers } from "../shared/mcp/mcp-servers.ts";
import { InteractiveAgent, type AgentResult, type CallerInfo } from "./agent.ts";
import { INTERACTIVE_MCP_SERVERS } from "./servers.ts";
import type { InteractiveEnv } from "./env.ts";

export { InteractiveAgent };

let validator: { key: string; instance: EntraTokenValidator } | undefined;

function getValidator(env: InteractiveEnv): EntraTokenValidator {
  const key = `${env.TENANT_ID}|${env.BLUEPRINT_CLIENT_ID}|${env.INBOUND_REQUIRED_SCOPES}|${env.INBOUND_ALLOWED_CLIENT_IDS}`;
  if (!validator || validator.key !== key) {
    const blueprint = (env.BLUEPRINT_CLIENT_ID ?? "").toLowerCase();
    validator = {
      key,
      instance: new EntraTokenValidator({
        tenantId: (env.TENANT_ID ?? "").toLowerCase(),
        audiences: [blueprint, `api://${blueprint}`],
        requiredScopes: splitList(env.INBOUND_REQUIRED_SCOPES || "access_agent"),
        allowedClientIds: splitList(env.INBOUND_ALLOWED_CLIENT_IDS),
        authorityHost: env.AUTHORITY_HOST,
      }),
    };
  }
  return validator.instance;
}

/** Maps an Agent RPC result (plain data) to an HTTP response. */
function fromAgent(value: unknown): Response {
  const result = value as AgentResult<Record<string, unknown>>;
  if (result.ok) return json(result);
  return json({ error: result.error }, result.status);
}

async function health(env: InteractiveEnv): Promise<Response> {
  const service = await getAgentTokenService(env);
  const { info } = service.certificate;
  const daysLeft = Math.floor((info.notAfter.getTime() - Date.now()) / 86_400_000);
  const { servers, problems } = readMcpServers(env, INTERACTIVE_MCP_SERVERS);
  return json({
    status: daysLeft > 0 ? "ok" : "certificate_expired",
    blueprintClientId: service.config.blueprintClientId,
    agentIdentityId: service.config.agentIdentityId,
    certificate: {
      subject: info.subject,
      thumbprintSha1: service.certificate.thumbprintSha1Hex,
      notAfter: info.notAfter.toISOString(),
      daysLeft,
      assertionAlgorithm: service.config.assertionAlgorithm,
    },
    mcpServers: [
      ...servers.map((s) => ({ id: s.id, url: s.url, scopes: s.scopes, serviceBinding: Boolean(s.service) })),
      ...problems.map((p) => ({ id: p.id, error: p.message })),
    ],
    chat: Boolean(env.AI),
  });
}

export default {
  async fetch(request: Request, env: InteractiveEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          name: "Entra Agent ID on Cloudflare: interactive agent",
          endpoints: {
            "GET /healthz": "configuration and certificate check (no token needed)",
            "GET /api/whoami": "identity chain: your token, the agent's T1 and its OBO token (claims only)",
            "GET /api/tools": "MCP tools visible to the agent on your behalf, per MCP server",
            "POST /api/tools/call": '{"name": "...", "arguments": {...}, "server": "echo"}  call one MCP tool directly (server is optional)',
            "POST /api/chat":
              '{"prompt": "How many users are in my tenant?"}  or  {"prompt": "Ask the echo server who is calling it", "newConversation": true, "debug": true, "model": "@cf/meta/llama-4-scout-17b-16e-instruct"}',
            "POST /api/reset": "clear your conversation",
          },
          auth: `Authorization: Bearer <token for api://${env.BLUEPRINT_CLIENT_ID}/${splitList(env.INBOUND_REQUIRED_SCOPES || "access_agent")[0]}>`,
        });
      }
      if (request.method === "GET" && url.pathname === "/healthz") return await health(env);
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found", "Not found");

      // 1. Inbound authorization: a v2 user token for THIS agent's blueprint.
      const user = await getValidator(env).validate(request.headers.get("Authorization"));
      const caller: CallerInfo = { oid: user.oid, name: user.displayName, clientId: user.clientId, scopes: user.scopes };

      // 2. Route to this user's Agent instance (Durable Object named by the user's oid).
      const agent = await getAgentByName(env.INTERACTIVE_AGENT, user.oid);

      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /api/whoami":
          return fromAgent(await agent.whoami(user.raw, caller));
        case "GET /api/tools":
          return fromAgent(await agent.listTools(user.raw));
        case "POST /api/tools/call": {
          const body = await readJsonBody(request);
          if (typeof body.name !== "string" || !body.name) throw new HttpError(400, "invalid_request", "name is required");
          const args = body.arguments && typeof body.arguments === "object" ? (body.arguments as Record<string, unknown>) : {};
          if (body.server !== undefined && (typeof body.server !== "string" || !body.server)) {
            throw new HttpError(400, "invalid_request", "server must be a server id such as enterprise or echo");
          }
          return fromAgent(await agent.callTool(user.raw, body.name, args, body.server as string | undefined));
        }
        case "POST /api/chat": {
          const body = await readJsonBody(request);
          for (const flag of ["newConversation", "debug"] as const) {
            if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
              throw new HttpError(400, "invalid_request", `${flag} must be true or false`);
            }
          }
          if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) {
            throw new HttpError(400, "invalid_request", "model must be a Workers AI model id from AI_MODEL_CHOICES");
          }
          return fromAgent(
            await agent.chat(user.raw, caller, String(body.prompt ?? ""), {
              newConversation: body.newConversation === true,
              debug: body.debug === true,
              ...(typeof body.model === "string" ? { model: body.model } : {}),
            }),
          );
        }
        case "POST /api/reset":
          return fromAgent(await agent.reset());
        default:
          throw new HttpError(404, "not_found", "Not found");
      }
    } catch (err) {
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<InteractiveEnv>;
