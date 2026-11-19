import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeCaller, callerPolicyFromEnv, classifyCaller, parseFacets } from "../src/shared/entra/agent-caller.ts";
import { ConfigurationError } from "../src/shared/config.ts";
import { TokenValidationError, type EntraAccessToken } from "../src/shared/entra/inbound-auth.ts";

const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const AGENT = "77777777-7777-7777-7777-777777777777";

function tokenOf(kind: "user" | "app", claims: Record<string, unknown>): EntraAccessToken {
  return {
    raw: "",
    claims: { tid: "t", iat: 1_700_000_000, exp: 1_700_003_600, ...claims },
    kind,
    oid: String(claims.oid ?? "oid"),
    tid: "t",
    scopes: typeof claims.scp === "string" ? claims.scp.split(" ") : [],
    roles: (claims.roles as string[]) ?? [],
    clientId: String(claims.azp ?? AGENT),
  };
}

test("parseFacets accepts strings, arrays and numbers", () => {
  assert.deepEqual(parseFacets("11 13"), ["11", "13"]);
  assert.deepEqual(parseFacets([11, 13]), ["11", "13"]);
  assert.deepEqual(parseFacets(11), ["11"]);
  assert.deepEqual(parseFacets(undefined), []);
});

test("classifies the Agent ID flows from claims", () => {
  const obo = classifyCaller(tokenOf("user", { scp: "Echo.Read", idtyp: "user", xms_par_app_azp: BLUEPRINT, xms_act_fct: "11", preferred_username: "adele@contoso.com" }));
  assert.equal(obo.flow, "agent-obo");
  assert.equal(obo.isAgent, true);
  assert.equal(obo.parentBlueprintAppId, BLUEPRINT);
  assert.match(obo.interpretation, /on behalf of user adele@contoso.com/);

  const appOnly = classifyCaller(tokenOf("app", { roles: ["Echo.Read.All"], idtyp: "app", xms_par_app_azp: BLUEPRINT, xms_sub_fct: "11" }));
  assert.equal(appOnly.flow, "agent-app-only");

  const agentUser = classifyCaller(tokenOf("user", { scp: "Echo.Read", xms_par_app_azp: BLUEPRINT, xms_sub_fct: [13] }));
  assert.equal(agentUser.flow, "agent-user");

  assert.equal(classifyCaller(tokenOf("user", { scp: "Echo.Read" })).flow, "delegated");
  assert.equal(classifyCaller(tokenOf("app", { roles: ["Echo.Read.All"] })).flow, "app-only");
  assert.equal(classifyCaller(tokenOf("app", { roles: ["x"] })).isAgent, false);
});

test("caller policy from environment", () => {
  const defaults = callerPolicyFromEnv({});
  assert.equal(defaults.requireAgent, true);
  assert.deepEqual(defaults.allowedFlows, []);
  const custom = callerPolicyFromEnv({ REQUIRE_AGENT_CALLER: "false", ALLOWED_CALLER_FLOWS: "agent-obo, agent-user", ALLOWED_AGENT_IDS: AGENT.toUpperCase() });
  assert.equal(custom.requireAgent, false);
  assert.deepEqual(custom.allowedFlows, ["agent-obo", "agent-user"]);
  assert.deepEqual(custom.allowedAgentIds, [AGENT]);
  assert.throws(() => callerPolicyFromEnv({ ALLOWED_CALLER_FLOWS: "obo" }), ConfigurationError);
});

test("authorizeCaller enforces agent-only, flows, blueprints and agent identities (403 access_denied)", () => {
  const obo = classifyCaller(tokenOf("user", { scp: "Echo.Read", xms_par_app_azp: BLUEPRINT }));
  const plain = classifyCaller(tokenOf("user", { scp: "Echo.Read" }));
  const policy = callerPolicyFromEnv({});
  authorizeCaller(obo, policy);
  assert.throws(() => authorizeCaller(plain, policy), (err: unknown) => err instanceof TokenValidationError && err.status === 403 && err.code === "access_denied" && !err.needsChallenge);
  authorizeCaller(plain, callerPolicyFromEnv({ REQUIRE_AGENT_CALLER: "false" }));
  assert.throws(() => authorizeCaller(obo, callerPolicyFromEnv({ ALLOWED_CALLER_FLOWS: "agent-app-only" })), TokenValidationError);
  assert.throws(() => authorizeCaller(obo, callerPolicyFromEnv({ ALLOWED_BLUEPRINT_IDS: "33333333-3333-3333-3333-333333333333" })), TokenValidationError);
  authorizeCaller(obo, callerPolicyFromEnv({ ALLOWED_BLUEPRINT_IDS: BLUEPRINT.toUpperCase(), ALLOWED_AGENT_IDS: AGENT }));
  assert.throws(() => authorizeCaller(obo, callerPolicyFromEnv({ ALLOWED_AGENT_IDS: "88888888-8888-8888-8888-888888888888" })), TokenValidationError);
});
