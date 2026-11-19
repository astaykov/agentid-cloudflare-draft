import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError, readAgentIdentityConfig, resolveSecret, splitList } from "../src/shared/config.ts";

const base = {
  TENANT_ID: "11111111-1111-1111-1111-111111111111",
  BLUEPRINT_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  AGENT_IDENTITY_ID: "33333333-3333-3333-3333-333333333333",
  BLUEPRINT_CERT_PEM: "x",
  BLUEPRINT_KEY_PEM: "y",
};

test("reads and normalises configuration", () => {
  const cfg = readAgentIdentityConfig({ ...base, TENANT_ID: base.TENANT_ID.toUpperCase(), ASSERTION_ALGORITHM: "rs256", AUTHORITY_HOST: "https://login.microsoftonline.us/" });
  assert.equal(cfg.tenantId, base.TENANT_ID);
  assert.equal(cfg.assertionAlgorithm, "RS256");
  assert.equal(cfg.authorityHost, "https://login.microsoftonline.us");
  assert.equal(cfg.msalLogLevel, "warning");
});

test("lists every problem at once", () => {
  assert.throws(
    () => readAgentIdentityConfig({ ...base, TENANT_ID: "<tenant>", AGENT_IDENTITY_ID: "", BLUEPRINT_KEY_PEM: "", ASSERTION_ALGORITHM: "HS256" }),
    (err: unknown) =>
      err instanceof ConfigurationError &&
      /TENANT_ID must be a GUID/.test(err.message) &&
      /AGENT_IDENTITY_ID is not set/.test(err.message) &&
      /BLUEPRINT_KEY_PEM/.test(err.message) &&
      /PS256 or RS256/.test(err.message),
  );
});

test("secrets can be strings or Secrets Store bindings", async () => {
  assert.equal(await resolveSecret("pem"), "pem");
  assert.equal(await resolveSecret({ get: async () => "from-store" }), "from-store");
  assert.deepEqual(splitList("a b,c  ,d"), ["a", "b", "c", "d"]);
});
