/**
 * The resource-side view of a Microsoft Entra Agent ID caller.
 *
 * An MCP server (or any API) that receives an Entra access token can tell from
 * the claims WHICH agent is calling, under WHICH blueprint, and in WHICH flow:
 *
 *   xms_par_app_azp  app ID of the parent agent identity blueprint (agent tokens only)
 *   azp              the client that asked for the token: the agent identity
 *   xms_act_fct      facets of the actor   (11 = agent identity)
 *   xms_sub_fct      facets of the subject (11 = agent identity, 13 = agent user)
 *   idtyp            "app" for application tokens, "user" for delegated tokens
 *   oid              the subject: the user (OBO), the agent user, or the agent identity (app-only)
 *
 * The xms_* claims (and idtyp in delegated tokens) are OPTIONAL claims: Entra emits them only
 * when the resource's app registration requests them (optionalClaims.accessToken).
 *
 * classifyCaller() turns a validated token into an AgentCaller, and
 * authorizeCaller() applies a policy: which flows, blueprints and agent
 * identities may call. Both work on claims only; the token must already be
 * validated (signature, issuer, audience, lifetime) by EntraTokenValidator.
 */
import { ConfigurationError, splitList } from "../config.ts";
import { TokenValidationError, type EntraAccessToken } from "./inbound-auth.ts";

export type CallerFlow =
  /** An agent identity acting on behalf of a signed-in user (OBO). */
  | "agent-obo"
  /** An agent identity acting as itself with application permissions. */
  | "agent-app-only"
  /** An agent identity acting as its own agent user (user_fic). */
  | "agent-user"
  /** A regular (non-agent) client app acting for a user. */
  | "delegated"
  /** A regular (non-agent) client app with application permissions. */
  | "app-only";

export const AGENT_FLOWS: readonly CallerFlow[] = ["agent-obo", "agent-app-only", "agent-user"];
export const ALL_FLOWS: readonly CallerFlow[] = [...AGENT_FLOWS, "delegated", "app-only"];

export interface AgentCaller {
  flow: CallerFlow;
  /** True when the token was issued to an agent identity. */
  isAgent: boolean;
  /** One sentence for humans (and for the whoami tool). */
  interpretation: string;
  tokenType: "user" | "app";
  idtyp?: string;
  /** azp: the agent identity for agent flows, otherwise the client app. */
  clientAppId: string;
  /** xms_par_app_azp: the agent identity blueprint the agent belongs to. */
  parentBlueprintAppId?: string;
  /** oid: the user (OBO), the agent user, or the agent identity itself (app-only). */
  subjectObjectId: string;
  subjectName?: string;
  scopes: string[];
  roles: string[];
  actorFacets: string[];
  subjectFacets: string[];
  tenantId: string;
  issuedAt?: string;
  expiresAt?: string;
}

/** xms_*_fct claims may arrive as "11", "11 13", [11, 13] or 11. */
export function parseFacets(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => parseFacets(v));
  return String(value)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function classifyCaller(token: EntraAccessToken): AgentCaller {
  const c = token.claims;
  const parent = str(c.xms_par_app_azp);
  const actorFacets = parseFacets(c.xms_act_fct);
  const subjectFacets = parseFacets(c.xms_sub_fct);
  const isAgent = Boolean(parent) || actorFacets.includes("11") || subjectFacets.includes("11") || subjectFacets.includes("13");
  const clientAppId = token.clientId;
  const subjectName = str(c.preferred_username) ?? str(c.upn) ?? str(c.name);
  const who = subjectName ?? token.oid;

  let flow: CallerFlow;
  let interpretation: string;
  if (token.kind === "app") {
    flow = isAgent ? "agent-app-only" : "app-only";
    interpretation = isAgent
      ? `Agent identity ${clientAppId} (blueprint ${parent ?? "unknown"}) calling as itself with application permissions (app-only).`
      : `Application ${clientAppId} calling with application permissions; not an agent.`;
  } else if (subjectFacets.includes("13")) {
    flow = "agent-user";
    interpretation = `Agent identity ${clientAppId} (blueprint ${parent ?? "unknown"}) acting as its own agent user ${who} (user_fic).`;
  } else if (isAgent) {
    flow = "agent-obo";
    interpretation = `Agent identity ${clientAppId} (blueprint ${parent ?? "unknown"}) acting on behalf of user ${who} (OBO).`;
  } else {
    flow = "delegated";
    interpretation = `Application ${clientAppId} acting on behalf of user ${who}; not an agent.`;
  }

  return {
    flow,
    isAgent,
    interpretation,
    tokenType: token.kind,
    idtyp: str(c.idtyp),
    clientAppId,
    parentBlueprintAppId: parent,
    subjectObjectId: token.oid,
    subjectName,
    scopes: token.scopes,
    roles: token.roles,
    actorFacets,
    subjectFacets,
    tenantId: token.tid,
    issuedAt: typeof c.iat === "number" ? new Date(c.iat * 1000).toISOString() : undefined,
    expiresAt: typeof c.exp === "number" ? new Date(c.exp * 1000).toISOString() : undefined,
  };
}

export interface CallerPolicy {
  /** Only tokens issued to agent identities. Default true. */
  requireAgent: boolean;
  /** Flows that may call. Empty = any flow (subject to requireAgent). */
  allowedFlows: CallerFlow[];
  /** xms_par_app_azp allow-list. Empty = any blueprint. */
  allowedBlueprintIds: string[];
  /** azp allow-list (agent identity IDs). Empty = any agent identity. */
  allowedAgentIds: string[];
}

export interface CallerPolicyEnv {
  REQUIRE_AGENT_CALLER?: string;
  ALLOWED_CALLER_FLOWS?: string;
  ALLOWED_BLUEPRINT_IDS?: string;
  ALLOWED_AGENT_IDS?: string;
}

export function callerPolicyFromEnv(env: CallerPolicyEnv): CallerPolicy {
  const flows = splitList(env.ALLOWED_CALLER_FLOWS).map((f) => f.toLowerCase());
  const unknown = flows.filter((f) => !ALL_FLOWS.includes(f as CallerFlow));
  if (unknown.length) {
    throw new ConfigurationError(`ALLOWED_CALLER_FLOWS: unknown flow(s) ${unknown.join(", ")}; use ${ALL_FLOWS.join(", ")}`);
  }
  return {
    requireAgent: (env.REQUIRE_AGENT_CALLER ?? "true").trim().toLowerCase() !== "false",
    allowedFlows: flows as CallerFlow[],
    allowedBlueprintIds: splitList(env.ALLOWED_BLUEPRINT_IDS).map((s) => s.toLowerCase()),
    allowedAgentIds: splitList(env.ALLOWED_AGENT_IDS).map((s) => s.toLowerCase()),
  };
}

/**
 * The Agent ID claims are optional claims of the resource: a token issued to an agent identity
 * carries them only when this server's app registration lists them under
 * optionalClaims.accessToken (npm run entra:setup does that for the echo app). So a missing
 * claim means either "not an agent" or "the app registration does not ask for the claims".
 */
export const NOT_AN_AGENT =
  "Only agent identities may call this server. The token has no Agent ID claims (xms_par_app_azp, xms_act_fct, xms_sub_fct): " +
  "the caller is not an agent identity, or this server's app registration does not list those optional claims for access tokens.";

/** Throws a 403 TokenValidationError ("access_denied") when the policy refuses the caller. */
export function authorizeCaller(caller: AgentCaller, policy: CallerPolicy): void {
  if (policy.requireAgent && !caller.isAgent) {
    throw new TokenValidationError("access_denied", NOT_AN_AGENT);
  }
  if (policy.allowedFlows.length && !policy.allowedFlows.includes(caller.flow)) {
    throw new TokenValidationError("access_denied", `The ${caller.flow} flow is not allowed here`);
  }
  if (policy.allowedBlueprintIds.length && !policy.allowedBlueprintIds.includes((caller.parentBlueprintAppId ?? "").toLowerCase())) {
    throw new TokenValidationError("access_denied", "The calling agent's blueprint is not allowed here");
  }
  if (policy.allowedAgentIds.length && !policy.allowedAgentIds.includes(caller.clientAppId.toLowerCase())) {
    throw new TokenValidationError("access_denied", "The calling agent identity is not allowed here");
  }
}
