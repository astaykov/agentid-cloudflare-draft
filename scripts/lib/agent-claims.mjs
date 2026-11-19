/**
 * Microsoft Entra Agent ID claims are OPTIONAL claims of the RESOURCE.
 *
 * Entra puts xms_par_app_azp, xms_act_fct, xms_sub_fct and xms_tnt_fct into an access
 * token only when the app registration of the API the token is FOR (the audience, here
 * the echo MCP server) lists them under optionalClaims.accessToken. Without them a token
 * issued to an agent identity looks like any other app's token, and a resource that
 * checks for agents (REQUIRE_AGENT_CALLER, the API Shield rule) refuses it with
 * 403 access_denied.
 *
 * Reference: https://learn.microsoft.com/entra/agent-id/agent-token-claims
 *            https://learn.microsoft.com/entra/identity-platform/optional-claims-reference
 *
 * Zero dependencies; used by scripts/entra/setup-entra.mjs and the tests.
 */

/** The access token optional claims the echo MCP server reads. */
export const AGENT_ACCESS_TOKEN_CLAIMS = Object.freeze([
  /** App ID of the agent identity blueprint (parent of azp). Present only in tokens issued to agent identities. */
  { name: "xms_par_app_azp", additionalProperties: [] },
  /** Actor facets: 11 = the actor (azp) is an agent identity. */
  { name: "xms_act_fct", additionalProperties: [] },
  /** Subject facets: 11 = the subject is the agent identity (app-only), 13 = an agent user. */
  { name: "xms_sub_fct", additionalProperties: [] },
  /** Tenant facets. */
  { name: "xms_tnt_fct", additionalProperties: [] },
  /** "app" or "user"; include_user_token emits it in delegated (OBO) tokens too, not only in app-only tokens. */
  { name: "idtyp", additionalProperties: ["include_user_token"] },
]);

/** The optionalClaims manifest fragment, for docs and for a manual fix. */
export function agentOptionalClaimsManifest() {
  return {
    optionalClaims: {
      accessToken: AGENT_ACCESS_TOKEN_CLAIMS.map((c) => ({ name: c.name, source: null, essential: false, additionalProperties: [...c.additionalProperties] })),
    },
  };
}

function cleanClaim(claim) {
  return {
    name: claim.name,
    source: claim.source ?? null,
    essential: claim.essential ?? false,
    additionalProperties: [...(claim.additionalProperties ?? [])],
  };
}

/**
 * Adds the agent claims to an application's optionalClaims and keeps everything that is
 * already there (other access token claims, ID token and SAML claims). Graph replaces the
 * whole optionalClaims object on PATCH, so the result carries all three collections.
 *
 * @returns {{ optionalClaims: { idToken: object[], accessToken: object[], saml2Token: object[] }, added: string[] }}
 *          `added` is empty when nothing has to change.
 */
export function mergeAgentClaims(current) {
  const accessToken = (current?.accessToken ?? []).map(cleanClaim);
  const added = [];
  for (const wanted of AGENT_ACCESS_TOKEN_CLAIMS) {
    const existing = accessToken.find((c) => c.name === wanted.name && !c.source);
    if (!existing) {
      accessToken.push(cleanClaim(wanted));
      added.push(wanted.name);
      continue;
    }
    const missing = wanted.additionalProperties.filter((p) => !existing.additionalProperties.includes(p));
    if (missing.length) {
      existing.additionalProperties.push(...missing);
      added.push(`${wanted.name} (${missing.join(", ")})`);
    }
  }
  return {
    optionalClaims: {
      idToken: (current?.idToken ?? []).map(cleanClaim),
      accessToken,
      saml2Token: (current?.saml2Token ?? []).map(cleanClaim),
    },
    added,
  };
}
