/**
 * Service binding calls carry no Host header.
 *
 * A request from the internet always has a Host header: Cloudflare sets it. A request that one
 * Worker sends to another through a service binding (env.BINDING.fetch) skips that front door
 * and carries only the headers the caller put on it. MCP handlers check Host against DNS
 * rebinding: createMcpHandler (Agents SDK) does so on localhost and workers.dev endpoints and
 * with allowedHostnames, and answers such a call with
 *   403 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing Host header"},"id":null}
 *
 * withHostHeader() gives a request without Host the host of its URL, which is what the same
 * request over the public URL would carry. A Host that is present is never changed, so the
 * DNS rebinding check still sees, and refuses, a wrong one. No package imports.
 */
export function withHostHeader(request: Request): Request {
  if (request.headers.has("host")) return request;
  const headers = new Headers(request.headers);
  headers.set("host", new URL(request.url).host);
  return new Request(request, { headers });
}
