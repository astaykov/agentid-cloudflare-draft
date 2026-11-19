#!/usr/bin/env node
/**
 * Creates a self-signed certificate + RSA private key for an agent identity
 * blueprint. Zero dependencies: Node.js 20+ built-ins only (no OpenSSL, no
 * PowerShell modules, nothing from a package feed).
 *
 *   node scripts/cert/new-blueprint-cert.mjs --name interactive-blueprint
 *
 * Writes to ./certs/<name>/ :
 *   <name>.cert.pem            public certificate  -> Worker secret BLUEPRINT_CERT_PEM, and upload to Entra
 *   <name>.key.pem             PKCS#8 private key  -> Worker secret BLUEPRINT_KEY_PEM (never commit it)
 *   <name>.cer                 DER certificate     -> Entra admin center upload
 *   <name>.keycredential.json  Microsoft Graph body for the blueprint's keyCredentials
 *   <name>.dev.vars            single-line values for local `wrangler dev`
 *
 * For production you may prefer a certificate issued by your PKI or created in
 * Azure Key Vault; see docs/certificate-auth.md.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- DER helpers
function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const value = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octets = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const explicit = (n, ...p) => tlv(0xa0 + n, ...p);
const integer = (b) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const bitString = (b) => tlv(0x03, Buffer.from([0]), b);
function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const p = (n) => String(n).padStart(2, "0");
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(p(y % 100) + rest)) : tlv(0x18, Buffer.from(String(y) + rest));
}
function toPem(label, der) {
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
/** Contents of the subjectPublicKey BIT STRING inside an SPKI (for the key identifier). */
function subjectPublicKeyBits(spki) {
  // SPKI = SEQUENCE { AlgorithmIdentifier, BIT STRING }
  let pos = 1;
  const readLen = () => {
    let len = spki[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + spki[pos++];
    }
    return len;
  };
  readLen(); // outer sequence
  pos++; // AlgorithmIdentifier tag
  pos += readLen(); // skip AlgorithmIdentifier
  pos++; // BIT STRING tag
  const len = readLen();
  return spki.subarray(pos + 1, pos + len); // skip "unused bits" byte
}

/**
 * Creates a self-signed RSA certificate suitable for Entra client assertions.
 * @returns {{certPem: string, keyPem: string, certDer: Buffer, x509: X509Certificate}}
 */
export function createSelfSignedCertificate({ commonName, months = 12, keySize = 2048, notBefore = new Date() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: keySize });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const start = new Date(notBefore.getTime() - 5 * 60 * 1000); // tolerate clock skew
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);

  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const sha256WithRsa = seq(oid("1.2.840.113549.1.1.11"), tlv(0x05));
  const name = seq(set(seq(oid("2.5.4.3"), utf8String(commonName))));
  const extensions = explicit(
    3,
    seq(
      seq(oid("2.5.29.19"), bool(true), octets(seq())), // basicConstraints: CA=false
      seq(oid("2.5.29.15"), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
      seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.2")))), // extendedKeyUsage: clientAuth
      seq(oid("2.5.29.14"), octets(octets(createHash("sha1").update(subjectPublicKeyBits(spki)).digest()))), // SKI
    ),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    sha256WithRsa,
    name,
    seq(time(start), time(end)),
    name,
    spki,
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const certDer = seq(tbs, sha256WithRsa, bitString(signature));
  const certPem = toPem("CERTIFICATE", certDer);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const x509 = new X509Certificate(certPem);
  if (!x509.checkPrivateKey(privateKey) || !x509.verify(publicKey)) {
    throw new Error("Generated certificate failed self-verification");
  }
  return { certPem, keyPem, certDer, x509, privateKey };
}

function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: "agentid-blueprint" },
      cn: { type: "string" },
      out: { type: "string", default: "certs" },
      months: { type: "string", default: "12" },
      "key-size": { type: "string", default: "2048" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/cert/new-blueprint-cert.mjs --name <name> [--cn <common name>] [--months 1-12] [--key-size 2048|3072|4096] [--out certs] [--force]");
    return;
  }
  const name = values.name;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("--name may contain letters, digits, '.', '_' and '-' only");
  const dir = resolve(values.out, name);
  if (existsSync(join(dir, `${name}.key.pem`)) && !values.force) {
    throw new Error(`${join(dir, `${name}.key.pem`)} already exists. Use --force to overwrite.`);
  }
  const keySize = Number(values["key-size"]);
  if (![2048, 3072, 4096].includes(keySize)) throw new Error("--key-size must be 2048, 3072 or 4096");
  const months = Number(values.months);
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new Error("--months must be between 1 and 12 (Entra limits certificate credentials to one year)");

  const { certPem, keyPem, certDer, x509 } = createSelfSignedCertificate({
    commonName: values.cn ?? name,
    months,
    keySize,
  });

  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, `${name}.key.pem`);
  writeFileSync(join(dir, `${name}.cert.pem`), certPem);
  writeFileSync(join(dir, `${name}.cer`), certDer);
  writeFileSync(keyFile, keyPem, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* Windows: ACLs are not changed */
  }

  const keyCredential = {
    keyCredentials: [
      {
        type: "AsymmetricX509Cert",
        usage: "Verify",
        key: certDer.toString("base64"),
        displayName: `CN=${x509.subject.replace(/^CN=/, "")}`,
        startDateTime: new Date(x509.validFrom).toISOString(),
        endDateTime: new Date(x509.validTo).toISOString(),
      },
    ],
  };
  writeFileSync(join(dir, `${name}.keycredential.json`), JSON.stringify(keyCredential, null, 2) + "\n");

  const oneLine = (pem) => pem.trim().replace(/\r?\n/g, "\\n");
  writeFileSync(
    join(dir, `${name}.dev.vars`),
    `# Paste into the Worker's .dev.vars for local development only. Never commit.\n` +
      `BLUEPRINT_CERT_PEM="${oneLine(certPem)}"\n` +
      `BLUEPRINT_KEY_PEM="${oneLine(keyPem)}"\n`,
    { mode: 0o600 },
  );

  const sha1 = x509.fingerprint.replace(/:/g, "");
  const sha256 = x509.fingerprint256.replace(/:/g, "");
  console.log(`Certificate for blueprint credential '${name}'
  Subject:            ${x509.subject}
  Valid from / to:    ${new Date(x509.validFrom).toISOString()}  ->  ${new Date(x509.validTo).toISOString()}
  Key:                RSA ${keySize}
  SHA-1 thumbprint:   ${sha1}   (what Entra shows as the certificate thumbprint)
  SHA-256 thumbprint: ${sha256}
  Files:              ${dir}

Next steps
  1. Upload ${name}.cer to the blueprint (Entra admin center) or PATCH ${name}.keycredential.json
     to /beta/applications/<blueprint-object-id> - see docs/entra-setup-guide.md.
  2. Store both PEM files as Worker secrets (see docs/cloudflare-deploy-guide.md), e.g.
       npx wrangler secret put BLUEPRINT_CERT_PEM -c <worker>/wrangler.jsonc < ${join(values.out, name, `${name}.cert.pem`)}
       npx wrangler secret put BLUEPRINT_KEY_PEM  -c <worker>/wrangler.jsonc < ${join(values.out, name, `${name}.key.pem`)}
  3. Keep ${name}.key.pem out of source control, and delete local copies once stored.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
