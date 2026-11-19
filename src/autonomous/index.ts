/**
 * Autonomous agent Worker.
 *
 *  Operator --POST /run--> AutonomousAgent.runJob()      (default: runs only when started)
 *  Cron Trigger (optional) -> scheduled() -> runJob()
 *  AutonomousAgent --(its own token: agent user or app-only)--> MCP server
 *
 * Inbound authorization is not part of this scenario. The two operational
 * endpoints (/status, /run) are for operators: Cloudflare Access in front of
 * the Worker (ADMIN_AUTH=access) or a shared ADMIN_KEY secret (default;
 * disabled when the secret is not set). See admin-auth.ts.
 */
import { getAgentByName } from "agents";
import { getAgentTokenService } from "../shared/entra/token-service-factory.ts";
import { errorResponse, HttpError, json } from "../shared/http.ts";
import { requireAdmin } from "./admin-auth.ts";
import { AutonomousAgent } from "./agent.ts";
import type { AutonomousEnv } from "./env.ts";

export { AutonomousAgent };

const AGENT_INSTANCE = "default";

export default {
  async fetch(request: Request, env: AutonomousEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          name: "Entra Agent ID on Cloudflare: autonomous agent",
          mode: env.AUTH_MODE || "agent-user",
          endpoints: {
            "GET /healthz": "configuration and certificate check",
            "GET /status": "last runs (operators: Cloudflare Access or x-admin-key)",
            "POST /run": "run the job now; the default configuration has no schedule (operators: Cloudflare Access or x-admin-key)",
          },
          adminAuth: env.ADMIN_AUTH || "admin-key",
        });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        const service = await getAgentTokenService(env);
        const { info } = service.certificate;
        return json({
          status: info.notAfter.getTime() > Date.now() ? "ok" : "certificate_expired",
          blueprintClientId: service.config.blueprintClientId,
          agentIdentityId: service.config.agentIdentityId,
          certificate: { subject: info.subject, thumbprintSha1: service.certificate.thumbprintSha1Hex, notAfter: info.notAfter.toISOString() },
          mode: env.AUTH_MODE || "agent-user",
          mcpServer: env.MCP_SERVER_URL,
        });
      }
      if (url.pathname === "/status" && request.method === "GET") {
        await requireAdmin(request, env, ctx);
        const agent = await getAgentByName(env.AUTONOMOUS_AGENT, AGENT_INSTANCE);
        return json(await agent.getStatus());
      }
      if (url.pathname === "/run" && request.method === "POST") {
        const operator = await requireAdmin(request, env, ctx);
        const agent = await getAgentByName(env.AUTONOMOUS_AGENT, AGENT_INSTANCE);
        const record = await agent.runJob(`manual (${operator})`);
        return json(record, record.ok ? 200 : record.error?.type === "already_running" ? 409 : 502);
      }
      throw new HttpError(404, "not_found", "Not found");
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(controller: ScheduledController, env: AutonomousEnv): Promise<void> {
    const agent = await getAgentByName(env.AUTONOMOUS_AGENT, AGENT_INSTANCE);
    await agent.runJob(`cron ${controller.cron}`);
  },
} satisfies ExportedHandler<AutonomousEnv>;
