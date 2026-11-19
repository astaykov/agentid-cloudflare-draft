/**
 * The blueprint certificate credential, held by the Worker as two secrets:
 *   BLUEPRINT_CERT_PEM  the public certificate (chain), leaf first
 *   BLUEPRINT_KEY_PEM   the RSA private key (PKCS#8 "BEGIN PRIVATE KEY" or PKCS#1 "BEGIN RSA PRIVATE KEY")
 *
 * The private key is imported into WebCrypto as a NON-EXTRACTABLE CryptoKey.
 * Signing uses the Workers runtime's native WebCrypto, so we do not depend on
 * node:crypto / jsonwebtoken support in workerd.
 */
import { parseCertificate, pkcs1ToPkcs8, type CertificateInfo } from "./der.ts";
import { base64ToBytes, bytesToBase64, bytesToBase64Url, bytesToHex, toArrayBuffer } from "./encoding.ts";

/** PS256 (RSA-PSS + SHA-256, x5t#S256) is what current MSAL versions send; RS256 (+ x5t) is the legacy form. */
export type AssertionAlgorithm = "PS256" | "RS256";

export interface BlueprintCertificate {
  /** Certificate chain for the JWT `x5c` header: standard Base64 DER, leaf first. */
  readonly x5c: readonly string[];
  /** Base64url SHA-256 thumbprint of the leaf, for the `x5t#S256` header. */
  readonly x5tS256: string;
  /** Base64url SHA-1 thumbprint of the leaf, for the legacy `x5t` header. */
  readonly x5t: string;
  readonly thumbprintSha256Hex: string;
  readonly thumbprintSha1Hex: string;
  readonly info: Omit<CertificateInfo, "subjectPublicKeyInfo">;
  sign(algorithm: AssertionAlgorithm, data: Uint8Array): Promise<Uint8Array>;
}

interface PemBlock {
  label: string;
  der: Uint8Array;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

/**
 * Parses PEM text. Tolerates values pasted into secrets as a single line with
 * literal "\n" sequences, and a Base64-encoded PEM file.
 */
export function parsePem(input: string): PemBlock[] {
  let text = input.trim().replace(/\\r/g, "").replace(/\\n/g, "\n");
  if (!text.includes("-----BEGIN")) {
    try {
      text = new TextDecoder().decode(base64ToBytes(text.replace(/\s+/g, "")));
    } catch {
      // fall through: no PEM blocks found
    }
  }
  const blocks: PemBlock[] = [];
  for (const match of text.matchAll(PEM_BLOCK)) {
    const body = match[2]
      .split(/\r?\n/)
      .filter((line) => !line.includes(":")) // drop RFC 1421 headers (Proc-Type, DEK-Info)
      .join("")
      .replace(/\s+/g, "");
    blocks.push({ label: match[1], der: base64ToBytes(body) });
  }
  return blocks;
}

// Plain object types (instead of DOM lib names) so they type-check against both
// @cloudflare/workers-types and lib.dom.
type ImportAlgorithm = { name: "RSA-PSS" | "RSASSA-PKCS1-v1_5"; hash: "SHA-256" };
type SignAlgorithm = { name: "RSA-PSS"; saltLength: number } | { name: "RSASSA-PKCS1-v1_5" };

function algorithmFor(alg: AssertionAlgorithm): ImportAlgorithm {
  return alg === "PS256"
    ? { name: "RSA-PSS", hash: "SHA-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
}

function signParamsFor(alg: AssertionAlgorithm): SignAlgorithm {
  // JWS PS256 uses a salt length equal to the hash length (32 bytes).
  return alg === "PS256" ? { name: "RSA-PSS", saltLength: 32 } : { name: "RSASSA-PKCS1-v1_5" };
}

export class CertificateConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateConfigurationError";
  }
}

/**
 * Loads and checks the blueprint certificate.
 * @param certPem certificate PEM (chain allowed). May be empty if keyPem also contains the certificate.
 * @param keyPem  private key PEM. Encrypted keys are not supported.
 */
export async function loadBlueprintCertificate(certPem: string, keyPem: string): Promise<BlueprintCertificate> {
  const keyBlocks = parsePem(keyPem);
  const certBlocks = [...parsePem(certPem ?? ""), ...keyBlocks].filter((b) => b.label === "CERTIFICATE");
  if (certBlocks.length === 0) {
    throw new CertificateConfigurationError(
      "No certificate found. Set BLUEPRINT_CERT_PEM to the PEM certificate registered on the agent identity blueprint.",
    );
  }
  // De-duplicate (the same certificate may appear in both secrets).
  const seen = new Set<string>();
  const chain = certBlocks.filter((b) => {
    const key = bytesToBase64(b.der);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const keyBlock = keyBlocks.find((b) => b.label === "PRIVATE KEY" || b.label === "RSA PRIVATE KEY");
  if (!keyBlock) {
    if (keyBlocks.some((b) => b.label === "ENCRYPTED PRIVATE KEY")) {
      throw new CertificateConfigurationError(
        "BLUEPRINT_KEY_PEM is an encrypted PKCS#8 key. Export it unencrypted (the Worker secret store encrypts it at rest).",
      );
    }
    throw new CertificateConfigurationError(
      "No RSA private key found in BLUEPRINT_KEY_PEM (expected 'BEGIN PRIVATE KEY' or 'BEGIN RSA PRIVATE KEY').",
    );
  }
  const pkcs8 = keyBlock.label === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(keyBlock.der) : keyBlock.der;

  const leaf = chain[0].der;
  const info = parseCertificate(leaf);
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(leaf)));
  const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", toArrayBuffer(leaf)));

  const keys = new Map<AssertionAlgorithm, Promise<CryptoKey>>();
  const importPrivateKey = (alg: AssertionAlgorithm): Promise<CryptoKey> => {
    let key = keys.get(alg);
    if (!key) {
      key = crypto.subtle.importKey("pkcs8", toArrayBuffer(pkcs8), algorithmFor(alg), false, ["sign"]);
      keys.set(alg, key);
    }
    return key;
  };

  const sign = async (alg: AssertionAlgorithm, data: Uint8Array): Promise<Uint8Array> => {
    const key = await importPrivateKey(alg);
    return new Uint8Array(await crypto.subtle.sign(signParamsFor(alg), key, toArrayBuffer(data)));
  };

  // Fail fast if the private key does not belong to the certificate: Entra would
  // otherwise reject every request with AADSTS700027 (invalid signature).
  let privateKeyOk = false;
  try {
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = await sign("RS256", probe);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(info.subjectPublicKeyInfo),
      algorithmFor("RS256"),
      false,
      ["verify"],
    );
    privateKeyOk = await crypto.subtle.verify(
      signParamsFor("RS256"),
      publicKey,
      toArrayBuffer(signature),
      toArrayBuffer(probe),
    );
  } catch (err) {
    throw new CertificateConfigurationError(
      `Could not use the blueprint key/certificate with WebCrypto (RSA keys only): ${(err as Error).message}`,
    );
  }
  if (!privateKeyOk) {
    throw new CertificateConfigurationError("BLUEPRINT_KEY_PEM does not match the leaf certificate in BLUEPRINT_CERT_PEM.");
  }

  const publicInfo = {
    subject: info.subject,
    issuer: info.issuer,
    serialNumberHex: info.serialNumberHex,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
  };
  return {
    x5c: chain.map((b) => bytesToBase64(b.der)),
    x5tS256: bytesToBase64Url(sha256),
    x5t: bytesToBase64Url(sha1),
    thumbprintSha256Hex: bytesToHex(sha256).toUpperCase(),
    thumbprintSha1Hex: bytesToHex(sha1).toUpperCase(),
    info: publicInfo,
    sign,
  };
}
