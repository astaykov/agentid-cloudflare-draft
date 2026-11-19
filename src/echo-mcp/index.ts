/**
 * Echo MCP server Worker, Cloudflare-native edition.
 *
 *   request
 *     -> OAuthResourceServer           (@cloudflare/workers-oauth-provider, resource-server role)
 *          publishes RFC 9728 metadata naming Microsoft Entra ID as the authorization server,
 *          answers 401 + WWW-Authenticate without a valid bearer token,
 *          calls validateToken = our Entra Agent ID check (signature, issuer, audience,
 *          scope/role, which agent / blueprint / flow, caller policy),
 *          enforces audience and expiry, then sets ctx.props and ctx.auth
 *     -> per-agent rate limit           (Workers Rate Limiting binding, optional)
 *     -> createMcpHandler               (Agents SDK, stateless, MCP SDK v2)
 *     -> tools read the caller          (getMcpAuthContext(); see server.ts)
 *
 * Cloudflare hosts and guards the MCP endpoint, Entra issues every token, and
 * this code decides which agents may call. Cloudflare mints no token here, so
 * the agent identity, its blueprint and the user stay visible end to end.
 *
 * Service binding calls (the agents use ECHO_MCP_SERVICE / MCP_SERVICE) arrive
 * without a Host header, and createMcpHandler's DNS rebinding check refuses those
 * on workers.dev with 403 "Missing Host header". Requests from the internet always
 * have Host, so a request without one came through a binding: it gets the host of
 * its URL. A Host that is present is left alone and still checked.
 */
import { OAuthError, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { splitList } from "../shared/config.ts";
import { withHostHeader } from "../shared/host-header.ts";
import { TokenValidationError } from "../shared/entra/inbound-auth.ts";
import { entraScopes } from "../shared/mcp/protected-resource.ts";
import {
  echoResourceConfig,
  enforceAgentRateLimit,
  RateLimitedError,
  rateLimitedResponse,
  verifyEchoToken,
  type EchoEnv,
  type EchoProps,
} from "./common.ts";
import { createEchoServer } from "./server.ts";

export interface NativeEchoEnv extends EchoEnv {
  /** Public URL of the MCP endpoint, e.g. https://echo-mcp.contoso.com/mcp. Default: <request origin>/mcp. */
  ECHO_RESOURCE_URL?: string;
  /** Custom-domain host names for createMcpHandler's Host check, comma-separated. */
  ECHO_ALLOWED_HOSTNAMES?: string;
}

function issuer(env: EchoEnv): string {
  const host = (env.AUTHORITY_HOST || "https://login.microsoftonline.com").replace(/\/+$/, "");
  return `${host}/${(env.TENANT_ID ?? "").toLowerCase()}/v2.0`;
}

/**
 * The Entra Agent ID check in the shape OAuthResourceServer expects:
 * (resource, token) => { props, audience, ... }. Errors become OAuth answers:
 * invalid_token -> 401, insufficient_scope -> 403 with a scope challenge,
 * access_denied (caller policy) -> 403. Anything unexpected (for example the
 * tenant's signing keys cannot be fetched) is rethrown and becomes a 503.
 */
export function entraAgentIdValidator(env: NativeEchoEnv, fetchImpl?: typeof fetch) {
  return async (resource: string, token: string) => {
    try {
      const caller = await verifyEchoToken(token, env, fetchImpl);
      const props: EchoProps = { caller };
      return {
        props,
        // Entra's aud (the echo app) was checked above; bind the token to this resource for the host's check.
        audience: resource,
        expiresAt: caller.expiresAt ? Math.floor(Date.parse(caller.expiresAt) / 1000) : undefined,
        scope: caller.tokenType === "app" ? caller.roles : caller.scopes,
        userId: caller.subjectObjectId,
        clientId: caller.clientAppId,
      };
    } catch (err) {
      if (err instanceof TokenValidationError) {
        const code = err.code === "invalid_request" ? "invalid_token" : err.code;
        throw new OAuthError(code, { description: err.message, statusCode: err.status });
      }
      // Configuration errors or Entra unreachable: OAuthResourceServer answers 503. Log why.
      console.error("echo-mcp: token validation could not run:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
}

// One host (and MCP handler) per configuration, per isolate.
const hosts = new Map<string, OAuthResourceServer<NativeEchoEnv, EchoProps>>();

function resourceServer(env: NativeEchoEnv, origin: string): OAuthResourceServer<NativeEchoEnv, EchoProps> {
  const resource = env.ECHO_RESOURCE_URL || `${origin}/mcp`;
  const key = [resource, env.TENANT_ID, env.ECHO_APP_ID, env.ECHO_REQUIRED_SCOPE, env.ECHO_ALLOWED_HOSTNAMES, env.AUTHORITY_HOST].join("|");
  let host = hosts.get(key);
  if (!host) {
    const allowedHostnames = splitList(env.ECHO_ALLOWED_HOSTNAMES);
    const mcp = createMcpHandler(createEchoServer, {
      route: new URL(resource).pathname,
      ...(allowedHostnames.length ? { allowedHostnames } : {}),
    });
    host = new OAuthResourceServer<NativeEchoEnv, EchoProps>({
      resourceMetadata: {
        resource,
        authorization_servers: [issuer(env)],
        bearer_methods_supported: ["header"],
        resource_name: "Entra Agent ID echo MCP server",
      },
      // Advertised in the 401 challenge and the metadata; the scope/role check itself is in verifyEchoToken.
      requiredScopes: entraScopes(echoResourceConfig(env)),
      validateToken: (workerEnv) => entraAgentIdValidator(workerEnv),
      handler: {
        async fetch(request, workerEnv, ctx) {
          try {
            await enforceAgentRateLimit(ctx.props.caller, workerEnv);
          } catch (err) {
            if (err instanceof RateLimitedError) return rateLimitedResponse();
            throw err;
          }
          return mcp(request, workerEnv, ctx);
        },
      },
    });
    hosts.set(key, host);
  }
  return host;
}

export default {
  async fetch(request: Request, env: NativeEchoEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      const config = echoResourceConfig(env);
      return Response.json({
        name: "Entra Agent ID echo MCP server (Cloudflare-native: OAuthResourceServer + createMcpHandler)",
        mcpEndpoint: env.ECHO_RESOURCE_URL || `${url.origin}/mcp`,
        authorizationServer: issuer(env),
        scopes: entraScopes(config),
        appRole: env.ECHO_REQUIRED_ROLE || "Echo.Read.All",
        agentsOnly: (env.REQUIRE_AGENT_CALLER ?? "true").toLowerCase() !== "false",
        rateLimited: Boolean(env.AGENT_RATE_LIMITER),
      });
    }
    return resourceServer(env, url.origin).fetch(withHostHeader(request), env, ctx);
  },
} satisfies ExportedHandler<NativeEchoEnv>;
