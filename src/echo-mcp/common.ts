/**
 * Shared by both echo MCP server editions:
 *   - src/echo-mcp       Cloudflare-native: Agents SDK createMcpHandler + MCP TypeScript SDK
 *   - src/echo-mcp-lite  dependency-free JSON-RPC (restricted package feeds, local tests)
 *
 * Holds the configuration, the Entra Agent ID resource guard (validate ->
 * classify -> authorize -> rate limit) and the tool behaviour. No package
 * imports, so it also runs in the Node tests.
 */
import {
  authorizeCaller,
  callerPolicyFromEnv,
  classifyCaller,
  type AgentCaller,
  type CallerPolicy,
  type CallerPolicyEnv,
} from "../shared/entra/agent-caller.ts";
import { EntraTokenValidator } from "../shared/entra/inbound-auth.ts";
import type { ProtectedResourceConfig } from "../shared/mcp/protected-resource.ts";

/** Workers Rate Limiting binding (the subset used here). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface EchoEnv extends CallerPolicyEnv {
  TENANT_ID: string;
  /** Application (client) ID of the echo MCP app registration: the token audience. */
  ECHO_APP_ID: string;
  /** Delegated scope required from user tokens (OBO, agent user). Default Echo.Read. */
  ECHO_REQUIRED_SCOPE?: string;
  /** App role required from application tokens (agent app-only). Default Echo.Read.All. */
  ECHO_REQUIRED_ROLE?: string;
  AUTHORITY_HOST?: string;
  /** Optional Workers Rate Limiting binding, keyed by the calling agent identity. */
  AGENT_RATE_LIMITER?: RateLimitBinding;
}

export const ECHO_SERVER_INFO = { name: "agentid-echo-mcp", version: "2.0.0" } as const;

export const ECHO_INSTRUCTIONS =
  "Echo server for the Entra Agent ID on Cloudflare sample. Call whoami to see how this server sees your identity.";

export const WHOAMI_TOOL = {
  name: "whoami",
  title: "Who am I?",
  description:
    "Who is calling this MCP server? Returns the caller's identity as this MCP server sees it: the Agent ID flow (OBO, app-only, agent user), the agent identity, its blueprint, the user, scopes or roles. Takes no arguments.",
} as const;

export const ECHO_TOOL = {
  name: "echo",
  title: "Echo",
  description: "Repeats a text the user gives, together with a one-line description of the caller. Use it only to echo a given text.",
  messageDescription: "Text to echo (max 2,000 characters are returned)",
} as const;

export class RateLimitedError extends Error {
  constructor() {
    super("Too many requests from this agent identity");
    this.name = "RateLimitedError";
  }
}

export function echoResourceConfig(env: EchoEnv): ProtectedResourceConfig {
  return {
    tenantId: (env.TENANT_ID ?? "").toLowerCase(),
    resourceAppId: (env.ECHO_APP_ID ?? "").toLowerCase(),
    scopes: [env.ECHO_REQUIRED_SCOPE || "Echo.Read"],
    mcpPath: "/mcp",
    authorityHost: env.AUTHORITY_HOST,
    resourceName: "Entra Agent ID echo MCP server",
  };
}

interface Guard {
  key: string;
  validator: EntraTokenValidator;
  policy: CallerPolicy;
}

// One validator per isolate: it caches the tenant's signing keys.
let guard: Guard | undefined;

function getGuard(env: EchoEnv, fetchImpl?: typeof fetch): Guard {
  const key = [
    env.TENANT_ID,
    env.ECHO_APP_ID,
    env.ECHO_REQUIRED_SCOPE,
    env.ECHO_REQUIRED_ROLE,
    env.REQUIRE_AGENT_CALLER,
    env.ALLOWED_CALLER_FLOWS,
    env.ALLOWED_BLUEPRINT_IDS,
    env.ALLOWED_AGENT_IDS,
    env.AUTHORITY_HOST,
  ].join("|");
  if (!guard || guard.key !== key || fetchImpl) {
    const appId = (env.ECHO_APP_ID ?? "").toLowerCase();
    guard = {
      key,
      validator: new EntraTokenValidator({
        tenantId: (env.TENANT_ID ?? "").toLowerCase(),
        audiences: [appId, `api://${appId}`],
        tokenTypes: "any",
        requiredScopes: [env.ECHO_REQUIRED_SCOPE || "Echo.Read"],
        requiredRoles: [env.ECHO_REQUIRED_ROLE || "Echo.Read.All"],
        authorityHost: env.AUTHORITY_HOST,
        fetchImpl,
      }),
      policy: callerPolicyFromEnv(env),
    };
  }
  return guard;
}

/**
 * The resource-side "authorizer", shared by both editions: validates the Entra
 * access token (signature against the tenant's keys, issuer, tenant, audience =
 * the echo app, lifetime, v2.0, delegated scope or app role), works out which
 * Agent ID flow produced it and applies the caller policy (agents only,
 * allowed flows, blueprints and agent identities).
 *
 * Accepts an Authorization header value or a bare token. Throws
 * TokenValidationError: 401 invalid_token, 403 insufficient_scope, 403 access_denied.
 */
export async function verifyEchoToken(authorizationOrToken: string | null, env: EchoEnv, fetchImpl?: typeof fetch): Promise<AgentCaller> {
  const { validator, policy } = getGuard(env, fetchImpl);
  const token = await validator.validate(authorizationOrToken);
  const caller = classifyCaller(token);
  authorizeCaller(caller, policy);
  return caller;
}

/** Optional per-agent-identity rate limit (Workers Rate Limiting binding). Throws RateLimitedError. */
export async function enforceAgentRateLimit(caller: AgentCaller, env: EchoEnv): Promise<void> {
  if (!env.AGENT_RATE_LIMITER) return;
  const { success } = await env.AGENT_RATE_LIMITER.limit({ key: caller.clientAppId });
  if (!success) throw new RateLimitedError();
}

/** verifyEchoToken + enforceAgentRateLimit for a request (dependency-free edition). */
export async function authenticateEchoCaller(request: Request, env: EchoEnv, fetchImpl?: typeof fetch): Promise<AgentCaller> {
  const caller = await verifyEchoToken(request.headers.get("Authorization"), env, fetchImpl);
  await enforceAgentRateLimit(caller, env);
  return caller;
}

/** What the Cloudflare-native edition passes to the MCP handler as ctx.props. */
export interface EchoProps {
  caller: AgentCaller;
  [key: string]: unknown;
}

/** One structured, token-free audit line per authorized MCP request (Workers Logs). */
export function auditLog(caller: AgentCaller, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: "echo_mcp_request",
      flow: caller.flow,
      agentIdentity: caller.clientAppId,
      blueprint: caller.parentBlueprintAppId,
      subject: caller.subjectObjectId,
      ...details,
    }),
  );
}

export function echoPayload(message: string, caller: AgentCaller) {
  return { echo: message.slice(0, 2000), flow: caller.flow, caller: caller.interpretation };
}

export function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limited", error_description: "Too many requests from this agent identity" }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" },
  });
}
