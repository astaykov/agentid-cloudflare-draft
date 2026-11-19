import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAdmin } from "../src/autonomous/admin-auth.ts";
import { ConfigurationError } from "../src/shared/config.ts";
import { HttpError } from "../src/shared/http.ts";

const request = (headers: Record<string, string> = {}) => new Request("https://agent.example/run", { method: "POST", headers });
const ctxWith = (access?: unknown) => ({ waitUntil() {}, passThroughOnException() {}, access }) as unknown as ExecutionContext;
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

test("admin-key mode: header must match the secret; endpoints are hidden without a secret", async () => {
  assert.equal(await requireAdmin(request({ "x-admin-key": "s3cret" }), { ADMIN_KEY: "s3cret" }, ctxWith()), "admin-key");
  await assert.rejects(requireAdmin(request({ "x-admin-key": "nope" }), { ADMIN_KEY: "s3cret" }, ctxWith()), (e: unknown) => e instanceof HttpError && e.status === 401);
  await assert.rejects(requireAdmin(request(), {}, ctxWith()), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("access mode: requires ctx.access from OUR Access application", async () => {
  const env = { ADMIN_AUTH: "access", ACCESS_AUD: AUD };
  const user = { aud: AUD, getIdentity: async () => ({ email: "operator@contoso.com" }) };
  assert.equal(await requireAdmin(request(), env, ctxWith(user)), "access:operator@contoso.com");
  const serviceToken = { aud: [AUD], getIdentity: async () => undefined };
  assert.equal(await requireAdmin(request(), env, ctxWith(serviceToken)), "access:service-token");
  await assert.rejects(requireAdmin(request(), env, ctxWith()), (e: unknown) => e instanceof HttpError && e.status === 403);
  const otherApp = { aud: "other", getIdentity: async () => ({ email: "x@contoso.com" }) };
  await assert.rejects(requireAdmin(request(), env, ctxWith(otherApp)), (e: unknown) => e instanceof HttpError && e.code === "access_denied");
  // The shared key does not open the door in access mode.
  await assert.rejects(requireAdmin(request({ "x-admin-key": "s3cret" }), { ...env, ADMIN_KEY: "s3cret" }, ctxWith()), HttpError);
  await assert.rejects(requireAdmin(request(), { ADMIN_AUTH: "access" }, ctxWith(user)), ConfigurationError);
});
