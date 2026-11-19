/**
 * Keeps the API Shield token configuration in step with the Entra tenant's
 * signing keys. API Shield does not read JWKS URLs itself, and Entra rolls its
 * keys over (new keys are published before use), so a frequent cron is enough.
 *
 * Optional; only with the edge authorizer (scripts/cloudflare/setup-edge-jwt-validation.mjs).
 * The Cloudflare API token lives in this Worker only, not in the agents or the MCP server.
 */
import { entraSigningKeys, updateTokenConfigurationKeys } from "../shared/cloudflare/api-shield.ts";

export interface SyncEnv {
  /** Secret: Cloudflare API token with Zone > API Gateway: Edit. */
  CF_API_TOKEN: string;
  ZONE_ID: string;
  TOKEN_CONFIG_ID: string;
  TENANT_ID: string;
  AUTHORITY_HOST?: string;
}

export async function syncKeys(env: SyncEnv, fetchImpl?: typeof fetch): Promise<{ kids: string[] }> {
  const keys = await entraSigningKeys(env.TENANT_ID, env.AUTHORITY_HOST || undefined, fetchImpl);
  await updateTokenConfigurationKeys({ apiToken: env.CF_API_TOKEN, fetchImpl }, env.ZONE_ID, env.TOKEN_CONFIG_ID, keys);
  return { kids: keys.map((k) => k.kid) };
}

export default {
  async scheduled(_controller: ScheduledController, env: SyncEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncKeys(env).then(
        (r) => console.log(JSON.stringify({ event: "edge_jwks_sync", ok: true, keys: r.kids })),
        (err) => console.error(JSON.stringify({ event: "edge_jwks_sync", ok: false, error: err instanceof Error ? err.message : String(err) })),
      ),
    );
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<SyncEnv>;
