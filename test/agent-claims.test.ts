import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ACCESS_TOKEN_CLAIMS, agentOptionalClaimsManifest, mergeAgentClaims } from "../scripts/lib/agent-claims.mjs";

test("an app without optional claims gets the Agent ID claims, and idtyp for user tokens too", () => {
  const { optionalClaims, added } = mergeAgentClaims(null);
  assert.deepEqual(added, ["xms_par_app_azp", "xms_act_fct", "xms_sub_fct", "xms_tnt_fct", "idtyp"]);
  assert.deepEqual(optionalClaims.accessToken.map((c: { name: string }) => c.name), added);
  const idtyp = optionalClaims.accessToken.find((c: { name: string }) => c.name === "idtyp");
  assert.deepEqual(idtyp.additionalProperties, ["include_user_token"]);
  assert.deepEqual(optionalClaims.idToken, []);
  assert.deepEqual(optionalClaims.saml2Token, []);
});

test("optional claims already on the app are kept, and a second run changes nothing", () => {
  const current = {
    idToken: [{ name: "email", source: null, essential: false, additionalProperties: [] as string[] }],
    accessToken: [
      { name: "acct", source: null, essential: false, additionalProperties: [] as string[] },
      { name: "idtyp", source: null, essential: false, additionalProperties: [] as string[] },
      { name: "xms_par_app_azp", source: null, essential: false, additionalProperties: [] as string[] },
    ],
    saml2Token: [],
  };
  const first = mergeAgentClaims(current);
  assert.deepEqual(first.added, ["xms_act_fct", "xms_sub_fct", "xms_tnt_fct", "idtyp (include_user_token)"]);
  assert.deepEqual(first.optionalClaims.idToken.map((c: { name: string }) => c.name), ["email"]);
  assert.deepEqual(
    first.optionalClaims.accessToken.map((c: { name: string }) => c.name),
    ["acct", "idtyp", "xms_par_app_azp", "xms_act_fct", "xms_sub_fct", "xms_tnt_fct"],
  );
  assert.equal(current.accessToken[1].additionalProperties.length, 0, "the input is not modified");
  assert.deepEqual(mergeAgentClaims(first.optionalClaims).added, []);
});

test("the manifest fragment lists the documented Agent ID claims", () => {
  const names = agentOptionalClaimsManifest().optionalClaims.accessToken.map((c: { name: string }) => c.name);
  for (const claim of ["xms_par_app_azp", "xms_act_fct", "xms_sub_fct", "xms_tnt_fct", "idtyp"]) assert.ok(names.includes(claim), claim);
  assert.equal(AGENT_ACCESS_TOKEN_CLAIMS.length, 5);
});
