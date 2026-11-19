/**
 * Test stand-in for OAuthResourceServer / OAuthError from
 * @cloudflare/workers-oauth-provider (resource-server role), following its
 * documented contract (docs/resource-servers.md): RFC 9728 metadata at
 * /.well-known/oauth-protected-resource<path>, 401 challenge without a token,
 * validateToken(env, request)(resource, token), null -> 401, OAuthError ->
 * its answer, anything else thrown -> 503, audience must equal the resource,
 * then ctx.props / ctx.auth and the handler.
 */
const PRM = "/.well-known/oauth-protected-resource";

export class OAuthError extends Error {
  constructor(code, options = {}) {
    super(options.description ?? code);
    this.code = code;
    this.statusCode = options.statusCode;
    this.headers = options.headers ?? {};
  }
}

export class OAuthResourceServer {
  constructor(options) {
    this.options = options;
  }

  async fetch(request, env, ctx) {
    const { resourceMetadata, requiredScopes = [], validateToken, handler } = this.options;
    const resource = new URL(resourceMetadata.resource);
    const metadataUrl = `${resource.origin}${PRM}${resource.pathname}`;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `${PRM}${resource.pathname}`) {
      return Response.json({ ...resourceMetadata, scopes_supported: requiredScopes });
    }
    const challenge = (status, error, description) => {
      const params = [error && `error="${error}"`, description && `error_description="${description}"`, `scope="${requiredScopes.join(" ")}"`, `resource_metadata="${metadataUrl}"`];
      return new Response(JSON.stringify({ error: error ?? "unauthorized", error_description: description }), {
        status,
        headers: { "WWW-Authenticate": `Bearer ${params.filter(Boolean).join(", ")}`, "content-type": "application/json" },
      });
    };
    const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
    if (!match) return challenge(401);
    let result;
    try {
      result = await validateToken(env, request)(resourceMetadata.resource, match[1]);
    } catch (err) {
      if (err instanceof OAuthError) {
        if (err.code === "invalid_token") return challenge(401, err.code, err.message);
        if (err.code === "insufficient_scope") return challenge(403, err.code, err.message);
        return new Response(JSON.stringify({ error: err.code, error_description: err.message }), { status: err.statusCode ?? 400, headers: err.headers });
      }
      return new Response(null, { status: 503 });
    }
    if (!result) return challenge(401, "invalid_token");
    if (result.audience !== resourceMetadata.resource) return challenge(401, "invalid_token", "audience");
    if (typeof result.expiresAt === "number" && result.expiresAt * 1000 < Date.now()) return challenge(401, "invalid_token", "expired");
    ctx.props = result.props;
    ctx.auth = { token: match[1], audience: result.audience, expiresAt: result.expiresAt, scope: result.scope ?? [], userId: result.userId, clientId: result.clientId };
    return handler.fetch(request, env, ctx);
  }
}
