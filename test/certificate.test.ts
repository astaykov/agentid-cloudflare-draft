import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createPublicKey, verify as nodeVerify } from "node:crypto";
// Zero-dependency generator shipped in scripts/cert
import { createSelfSignedCertificate } from "../scripts/cert/new-blueprint-cert.mjs";
import { loadBlueprintCertificate, parsePem } from "../src/shared/entra/certificate.ts";
import { createClientAssertion } from "../src/shared/entra/client-assertion.ts";
import { decodeJwtHeader, decodeJwtPayload } from "../src/shared/entra/claims.ts";
import { base64UrlToBytes } from "../src/shared/entra/encoding.ts";

const generated = createSelfSignedCertificate({ commonName: "agentid-test-blueprint", months: 3 });

test("loads certificate and key; thumbprints match Node's X509Certificate", async () => {
  const cert = await loadBlueprintCertificate(generated.certPem, generated.keyPem);
  assert.equal(cert.thumbprintSha1Hex, generated.x509.fingerprint.replace(/:/g, ""));
  assert.equal(cert.thumbprintSha256Hex, generated.x509.fingerprint256.replace(/:/g, ""));
  assert.equal(cert.x5c.length, 1);
  assert.equal(cert.x5c[0], generated.certDer.toString("base64"));
  assert.equal(cert.info.subject, "CN=agentid-test-blueprint");
  assert.equal(cert.info.notAfter.toISOString(), new Date(generated.x509.validTo).toISOString());
  assert.equal(cert.info.notBefore.toISOString(), new Date(generated.x509.validFrom).toISOString());
});

test("accepts single-line secrets with literal \\n and a PKCS#1 key", async () => {
  const pkcs1 = generated.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const oneLineCert = generated.certPem.trim().replace(/\n/g, "\\n");
  const cert = await loadBlueprintCertificate(oneLineCert, pkcs1);
  assert.equal(cert.thumbprintSha256Hex, generated.x509.fingerprint256.replace(/:/g, ""));
});

test("accepts a combined PEM (key + certificate in one secret)", async () => {
  const cert = await loadBlueprintCertificate("", `${generated.keyPem}\n${generated.certPem}`);
  assert.equal(cert.x5c.length, 1);
});

test("accepts a Base64-encoded PEM file", async () => {
  const cert = await loadBlueprintCertificate(
    Buffer.from(generated.certPem).toString("base64"),
    Buffer.from(generated.keyPem as string).toString("base64"),
  );
  assert.equal(cert.x5c.length, 1);
});

test("rejects a key that does not match the certificate", async () => {
  const other = createSelfSignedCertificate({ commonName: "other" });
  await assert.rejects(loadBlueprintCertificate(generated.certPem, other.keyPem), /does not match/);
});

test("rejects an encrypted private key with a helpful message", async () => {
  const encrypted = generated.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" }) as string;
  await assert.rejects(loadBlueprintCertificate(generated.certPem, encrypted), /encrypted PKCS#8/);
});

test("parsePem ignores RFC 1421 headers", () => {
  const blocks = parsePem(generated.certPem.replace("-----\n", "-----\nProc-Type: 4,ENCRYPTED\n"));
  assert.equal(blocks[0].label, "CERTIFICATE");
});

for (const algorithm of ["PS256", "RS256"] as const) {
  test(`client assertion (${algorithm}) has the MSAL/Entra shape and a valid signature`, async () => {
    const cert = await loadBlueprintCertificate(generated.certPem, generated.keyPem);
    const tokenEndpoint = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token";
    const nowMs = Date.UTC(2026, 10, 10, 12, 0, 0);
    const jwt = await createClientAssertion(cert, {
      clientId: "22222222-2222-2222-2222-222222222222",
      tokenEndpoint,
      algorithm,
      nowMs,
    });
    const [h, p, s] = jwt.split(".");
    const header = decodeJwtHeader(jwt)!;
    const payload = decodeJwtPayload(jwt)!;
    assert.equal(header.alg, algorithm);
    assert.equal(header.typ, "JWT");
    assert.deepEqual(header.x5c, [generated.certDer.toString("base64")]);
    if (algorithm === "PS256") {
      assert.equal(header["x5t#S256"], Buffer.from(generated.x509.fingerprint256.replace(/:/g, ""), "hex").toString("base64url"));
      assert.equal(header.x5t, undefined);
    } else {
      assert.equal(header.x5t, Buffer.from(generated.x509.fingerprint.replace(/:/g, ""), "hex").toString("base64url"));
    }
    assert.equal(payload.aud, tokenEndpoint);
    assert.equal(payload.iss, "22222222-2222-2222-2222-222222222222");
    assert.equal(payload.sub, "22222222-2222-2222-2222-222222222222");
    assert.equal(payload.exp, nowMs / 1000 + 600);
    assert.equal(payload.nbf, nowMs / 1000);
    assert.match(String(payload.jti), /^[0-9a-f-]{36}$/);

    const publicKey = createPublicKey(generated.certPem);
    const ok = nodeVerify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      algorithm === "PS256"
        ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
        : { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(base64UrlToBytes(s)),
    );
    assert.ok(ok, "signature must verify with the certificate's public key");
  });
}

test("sendX5c=false omits the chain", async () => {
  const cert = await loadBlueprintCertificate(generated.certPem, generated.keyPem);
  const jwt = await createClientAssertion(cert, { clientId: "c", tokenEndpoint: "https://x/token", sendX5c: false });
  assert.equal(decodeJwtHeader(jwt)!.x5c, undefined);
});
