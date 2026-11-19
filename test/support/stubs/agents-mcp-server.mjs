/**
 * Test stand-in for createMcpHandler / getMcpAuthContext from "agents/mcp/server",
 * following the documented contract: exact route, a fresh server per request from
 * the factory, auth context = options.authContext or ctx.props, ctx.auth exposed
 * to tools as context.http.authInfo.
 *
 * Host check (DNS rebinding protection), as documented and as seen on a deployed
 * Worker: on localhost and workers.dev endpoints, or with allowedHostnames, a
 * request needs a Host header whose host name is allowed. Without one the answer is
 *   403 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing Host header"},"id":null}
 * which is what a service binding call without Host received.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function getMcpAuthContext() {
  return storage.getStore();
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function jsonRpcError(status, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** undefined = the Host is fine; otherwise the refusal. */
function hostRejection(request, allowedHostnames) {
  const endpoint = new URL(request.url).hostname;
  const allowed = allowedHostnames?.length
    ? allowedHostnames
    : LOCAL_HOSTS.has(endpoint) || endpoint.endsWith(".workers.dev")
      ? [endpoint]
      : undefined;
  if (!allowed) return undefined;
  const host = request.headers.get("host");
  if (!host) return jsonRpcError(403, "Missing Host header");
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return jsonRpcError(403, `Invalid Host header: ${host}`);
  }
  return allowed.includes(hostname) ? undefined : jsonRpcError(403, `Invalid Host: ${hostname}`);
}

export function createMcpHandler(factory, options = {}) {
  const route = options.route ?? "/mcp";
  return async (request, env, ctx) => {
    if (new URL(request.url).pathname !== route) return new Response("Not found", { status: 404 });
    const refused = hostRejection(request, options.allowedHostnames);
    if (refused) return refused;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const authContext = options.authContext ?? (ctx?.props ? { props: ctx.props } : undefined);
    const authInfo = ctx?.auth
      ? { token: ctx.auth.token, clientId: ctx.auth.clientId, scopes: ctx.auth.scope, expiresAt: ctx.auth.expiresAt }
      : undefined;
    const server = await factory({ era: "legacy", authInfo, requestInfo: request });
    const message = await request.json();
    return storage.run(authContext, () => server.handleForTests(message, { http: { authInfo } }));
  };
}
