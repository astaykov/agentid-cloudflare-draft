/**
 * Operator authorization for the autonomous agent's /status and /run endpoints.
 *
 *  ADMIN_AUTH=access     Cloudflare Access protects the Worker (Workers > your Worker >
 *                        Access, or a self-hosted Access application). Access evaluates
 *                        every request BEFORE the Worker runs; operators sign in with
 *                        Entra ID (Access identity provider), automation presents an
 *                        Access service token. The Worker only checks the platform-
 *                        validated ctx.access and that it belongs to OUR Access app.
 *                        This is the counterpart of IAM (SigV4) auth on AgentCore's
 *                        InvokeAgentRuntime in the AWS sample.
 *  ADMIN_AUTH=admin-key  (default) a shared secret header, for first tests.
 *
 * No npm imports, so it runs in the Node tests.
 */
import { ConfigurationError } from "../shared/config.ts";
import { HttpError, secretsEqual } from "../shared/http.ts";

/** What Cloudflare Access hands the Worker when it authenticated the request (ctx.access). */
export interface AccessContext {
  aud: string | string[];
  getIdentity(): Promise<Record<string, unknown> | undefined | null>;
}

export interface AdminAuthEnv {
  ADMIN_AUTH?: string;
  ACCESS_AUD?: string;
  ADMIN_KEY?: string;
}

/** Returns who called, for the run record: "access:<email>", "access:service-token" or "admin-key". */
export async function requireAdmin(request: Request, env: AdminAuthEnv, ctx: ExecutionContext): Promise<string> {
  const mode = (env.ADMIN_AUTH || "admin-key").toLowerCase();
  if (mode === "access") {
    if (!env.ACCESS_AUD) throw new ConfigurationError("ADMIN_AUTH=access needs ACCESS_AUD (the Access application's AUD tag)");
    const access = (ctx as unknown as { access?: AccessContext }).access;
    if (!access) throw new HttpError(403, "access_required", "Reach this endpoint through Cloudflare Access");
    const audiences = Array.isArray(access.aud) ? access.aud : [access.aud];
    if (!audiences.includes(env.ACCESS_AUD)) throw new HttpError(403, "access_denied", "Request was authenticated by a different Access application");
    const identity = await access.getIdentity().catch(() => undefined);
    const email = identity && typeof identity.email === "string" ? identity.email : undefined;
    return email ? `access:${email}` : "access:service-token";
  }
  if (mode !== "admin-key") throw new ConfigurationError("ADMIN_AUTH must be admin-key or access");
  if (!env.ADMIN_KEY) throw new HttpError(404, "not_found", "Not found");
  const presented = request.headers.get("x-admin-key") ?? "";
  if (!(await secretsEqual(presented, env.ADMIN_KEY))) throw new HttpError(401, "unauthorized", "Missing or wrong x-admin-key");
  return "admin-key";
}
