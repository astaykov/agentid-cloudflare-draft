import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EntraTokenValidator, TokenValidationError, clearSigningKeyCache } from "../src/shared/entra/inbound-auth.ts";
import { bytesToBase64Url, jsonToBase64Url, utf8Encode, toArrayBuffer } from "../src/shared/entra/encoding.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`;

const keyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

let jwks: unknown[] = [];
let fetchCount = 0;
const fakeFetch: typeof fetch = async (input) => {
  fetchCount++;
  const url = String(input);
  if (url.endsWith("/.well-known/openid-configuration")) {
    return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URI }), { status: 200 });
  }
  if (url === JWKS_URI) return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
  return new Response("not found", { status: 404 });
};

async function makeToken(claims: Record<string, unknown>, kid = "key-1", alg = "RS256"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: BLUEPRINT,
    iss: ISSUER,
    tid: TENANT,
    ver: "2.0",
    oid: "33333333-3333-3333-3333-333333333333",
    azp: "44444444-4444-4444-4444-444444444444",
    scp: "access_agent",
    name: "Test User",
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...claims,
  };
  const input = `${jsonToBase64Url({ alg, typ: "JWT", kid })}.${jsonToBase64Url(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, toArrayBuffer(utf8Encode(input))));
  return `${input}.${bytesToBase64Url(sig)}`;
}

function validator(extra: Partial<ConstructorParameters<typeof EntraTokenValidator>[0]> = {}) {
  return new EntraTokenValidator({
    tenantId: TENANT,
    audiences: [BLUEPRINT, `api://${BLUEPRINT}`],
    requiredScopes: ["access_agent"],
    fetchImpl: fakeFetch,
    ...extra,
  });
}

async function expectFailure(promise: Promise<unknown>, code: string, pattern: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TokenValidationError, "expected TokenValidationError");
    assert.equal(err.code, code);
    assert.match(err.message, pattern);
    return true;
  });
}

beforeEach(() => {
  clearSigningKeyCache();
  jwks = [{ ...publicJwk, kid: "key-1", use: "sig" }];
  fetchCount = 0;
});

test("accepts a valid v2 user token for the blueprint", async () => {
  const token = await makeToken({});
  const result = await validator().validate(`Bearer ${token}`);
  assert.equal(result.oid, "33333333-3333-3333-3333-333333333333");
  assert.deepEqual(result.scopes, ["access_agent"]);
  assert.equal(result.clientId, "44444444-4444-4444-4444-444444444444");
  assert.equal(result.raw, token);
});

test("accepts the api:// form of the audience", async () => {
  await validator().validate(`Bearer ${await makeToken({ aud: `api://${BLUEPRINT}` })}`);
});

test("rejects other audiences", async () => {
  await expectFailure(validator().validate(`Bearer ${await makeToken({ aud: "api://someone-else" })}`), "invalid_token", /audience/);
});

test("rejects a bad signature", async () => {
  const token = await makeToken({});
  const tampered = token.slice(0, token.lastIndexOf(".") + 1) + "AAAA" + token.slice(token.lastIndexOf(".") + 5);
  await expectFailure(validator().validate(tampered), "invalid_token", /signature/);
});

test("rejects a modified payload", async () => {
  const token = await makeToken({});
  const [h, , s] = token.split(".");
  const forged = `${h}.${jsonToBase64Url({ aud: BLUEPRINT, iss: ISSUER, tid: TENANT, ver: "2.0", scp: "access_agent", oid: "x", exp: 9999999999 })}.${s}`;
  await expectFailure(validator().validate(forged), "invalid_token", /signature/);
});

test("rejects alg=none and HS256", async () => {
  const token = await makeToken({}, "key-1", "none");
  await expectFailure(validator().validate(token), "invalid_token", /algorithm/);
  const hs = await makeToken({}, "key-1", "HS256");
  await expectFailure(validator().validate(hs), "invalid_token", /algorithm/);
});

test("rejects expired tokens (beyond clock skew)", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  await expectFailure(validator().validate(await makeToken({ exp: past, nbf: past - 60, iat: past - 60 })), "invalid_token", /expired/);
});

test("rejects other issuers and tenants", async () => {
  await expectFailure(validator().validate(await makeToken({ iss: "https://sts.windows.net/x/" })), "invalid_token", /issuer/);
  await expectFailure(validator().validate(await makeToken({ tid: "99999999-9999-9999-9999-999999999999" })), "invalid_token", /tenant/);
});

test("explains v1 tokens", async () => {
  await expectFailure(validator().validate(await makeToken({ ver: "1.0" })), "invalid_token", /requestedAccessTokenVersion/);
});

test("requires a delegated user token with the scope", async () => {
  await expectFailure(validator().validate(await makeToken({ scp: undefined, roles: ["x"], idtyp: "app" })), "insufficient_scope", /user/);
  await expectFailure(validator().validate(await makeToken({ scp: "something.else" })), "insufficient_scope", /access_agent/);
});

test("optional client allow-list", async () => {
  const v = validator({ allowedClientIds: ["55555555-5555-5555-5555-555555555555"] });
  await expectFailure(v.validate(await makeToken({})), "invalid_token", /client/);
});

test("refreshes the JWKS once for an unknown kid (key rollover)", async () => {
  await validator().validate(await makeToken({}));
  const before = fetchCount;
  jwks = [{ ...publicJwk, kid: "key-1", use: "sig" }, { ...publicJwk, kid: "key-2", use: "sig" }];
  // Rollover is rate-limited to one refresh per minute; simulate time passing by clearing the cache timestamp.
  clearSigningKeyCache();
  await validator().validate(await makeToken({}, "key-2"));
  assert.ok(fetchCount > before);
});

test("missing header gives invalid_request (401)", async () => {
  await expectFailure(validator().validate(undefined), "invalid_request", /Missing/);
  const err = new TokenValidationError("insufficient_scope", "x");
  assert.equal(err.status, 403);
  assert.match(err.toWwwAuthenticate(), /^Bearer error="insufficient_scope"/);
});

test("app tokens: rejected by default, accepted with tokenTypes=app and the role", async () => {
  const appToken = await makeToken({ scp: undefined, idtyp: "app", roles: ["Echo.Read.All"], xms_par_app_azp: BLUEPRINT });
  await expectFailure(validator().validate(appToken), "insufficient_scope", /user/);
  const v = validator({ tokenTypes: "app", requiredRoles: ["Echo.Read.All"], requireAgentCaller: true });
  const result = await v.validate(appToken);
  assert.equal(result.kind, "app");
  assert.deepEqual(result.roles, ["Echo.Read.All"]);
  await expectFailure(validator({ tokenTypes: "any", requiredRoles: ["Other.Role"] }).validate(appToken), "insufficient_scope", /Other.Role/);
});

test("requireAgentCaller rejects tokens not issued to an agent identity", async () => {
  const v = validator({ tokenTypes: "any", requireAgentCaller: true });
  await expectFailure(v.validate(await makeToken({})), "invalid_token", /agent/);
  const ok = await v.validate(await makeToken({ xms_par_app_azp: BLUEPRINT }));
  assert.equal(ok.kind, "user");
});
