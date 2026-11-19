/**
 * Builds the certificate-based client assertion (RFC 7523 JWT) that the
 * blueprint presents to Microsoft Entra ID.
 *
 * This is exactly what MSAL builds internally from `clientCertificate`
 * (PS256 + x5t#S256, or RS256 + x5t) including the `x5c` header that MSAL adds
 * when SN+I / "send x5c" is enabled. We hand the result to MSAL through its
 * `clientAssertion` callback, so MSAL still runs the protocol (Leg 1 with
 * fmi_path, caching, retries) while the signature is produced by WebCrypto.
 */
import type { AssertionAlgorithm, BlueprintCertificate } from "./certificate.ts";
import { bytesToBase64Url, jsonToBase64Url, utf8Encode } from "./encoding.ts";

export interface ClientAssertionOptions {
  /** The blueprint's application (client) ID: used as `iss` and `sub`. */
  clientId: string;
  /** The token endpoint the assertion is sent to: used as `aud`. */
  tokenEndpoint: string;
  algorithm?: AssertionAlgorithm;
  /** Include the certificate chain (`x5c`). Required for SN+I, which FMI (Leg 1) requires. Default: true. */
  sendX5c?: boolean;
  /** Assertion lifetime in seconds. MSAL uses 600. */
  lifetimeSeconds?: number;
  /** For tests. */
  nowMs?: number;
}

export async function createClientAssertion(
  certificate: BlueprintCertificate,
  options: ClientAssertionOptions,
): Promise<string> {
  const algorithm = options.algorithm ?? "PS256";
  const header: Record<string, unknown> = { alg: algorithm, typ: "JWT" };
  if (algorithm === "PS256") header["x5t#S256"] = certificate.x5tS256;
  else header.x5t = certificate.x5t;
  if (options.sendX5c !== false) header.x5c = [...certificate.x5c];

  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const payload = {
    aud: options.tokenEndpoint,
    iss: options.clientId,
    sub: options.clientId,
    jti: crypto.randomUUID(),
    nbf: now,
    iat: now,
    exp: now + (options.lifetimeSeconds ?? 600),
  };

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const signature = await certificate.sign(algorithm, utf8Encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}
