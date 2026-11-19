/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for an MCP server whose
 * authorization server is Microsoft Entra ID, plus the matching
 * WWW-Authenticate challenges (RFC 6750, MCP authorization spec).
 *
 * Entra issues tokens per scope (api://<app id>/<scope>), not per RFC 8707
 * resource indicator, so the Entra scopes go into scopes_supported and the
 * challenge's scope parameter, while `resource` is the MCP endpoint URL that
 * MCP clients compare against the URL they called.
 */
import type { TokenValidationError } from "../entra/inbound-auth.ts";

export const PRM_PATH = "/.well-known/oauth-protected-resource";

export interface ProtectedResourceConfig {
  tenantId: string;
  /** Application (client) ID of the MCP server's app registration. */
  resourceAppId: string;
  /** Delegated scope names, e.g. ["Echo.Read"]. */
  scopes: string[];
  /** Path of the MCP endpoint. Default /mcp. */
  mcpPath?: string;
  authorityHost?: string;
  resourceName?: string;
}

export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === PRM_PATH || pathname.startsWith(`${PRM_PATH}/`);
}

/** Path-suffixed metadata URL for the MCP endpoint (RFC 9728 section 3.1). */
export function metadataUrl(origin: string, config: Pick<ProtectedResourceConfig, "mcpPath">): string {
  return `${origin}${PRM_PATH}${config.mcpPath ?? "/mcp"}`;
}

export function entraScopes(config: Pick<ProtectedResourceConfig, "resourceAppId" | "scopes">): string[] {
  return config.scopes.map((s) => `api://${config.resourceAppId}/${s}`);
}

export function protectedResourceMetadata(origin: string, config: ProtectedResourceConfig): Record<string, unknown> {
  const host = (config.authorityHost || "https://login.microsoftonline.com").replace(/\/+$/, "");
  return {
    resource: `${origin}${config.mcpPath ?? "/mcp"}`,
    authorization_servers: [`${host}/${config.tenantId}/v2.0`],
    scopes_supported: entraScopes(config),
    bearer_methods_supported: ["header"],
    resource_name: config.resourceName ?? "MCP server protected by Microsoft Entra ID",
  };
}

export function metadataResponse(origin: string, config: ProtectedResourceConfig): Response {
  return new Response(JSON.stringify(protectedResourceMetadata(origin, config), null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * JSON error response for a rejected token. 401 and insufficient_scope carry a
 * Bearer challenge pointing to the metadata; access_denied (policy) does not.
 */
export function tokenErrorResponse(err: TokenValidationError, origin: string, config: ProtectedResourceConfig): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (err.needsChallenge) {
    const scope = entraScopes(config).join(" ");
    headers["WWW-Authenticate"] = `${err.toWwwAuthenticate()}, scope="${scope}", resource_metadata="${metadataUrl(origin, config)}"`;
  }
  return new Response(JSON.stringify({ error: err.code, error_description: err.message }), { status: err.status, headers });
}
