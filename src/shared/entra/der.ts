/**
 * Just enough DER (ASN.1) handling to:
 *  - wrap a PKCS#1 RSA key into PKCS#8 (WebCrypto only imports PKCS#8),
 *  - read subject, issuer, validity and public key from an X.509 certificate,
 *    so the Worker can sanity-check its certificate at start-up.
 * It is not a general ASN.1 library.
 */
import { bytesToHex, concatBytes } from "./encoding.ts";

export interface Tlv {
  tag: number;
  start: number;
  headerLength: number;
  length: number;
  end: number;
}

export function readTlv(buf: Uint8Array, pos: number): Tlv {
  if (pos + 2 > buf.length) throw new Error("DER: truncated header");
  const tag = buf[pos];
  let length = buf[pos + 1];
  let headerLength = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error("DER: unsupported length encoding");
    if (pos + 2 + count > buf.length) throw new Error("DER: truncated length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos + 2 + i];
    headerLength += count;
  }
  const end = pos + headerLength + length;
  if (end > buf.length) throw new Error("DER: value exceeds buffer");
  return { tag, start: pos, headerLength, length, end };
}

export function childrenOf(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.start + parent.headerLength;
  while (pos < parent.end) {
    const child = readTlv(buf, pos);
    out.push(child);
    pos = child.end;
  }
  return out;
}

export function valueOf(buf: Uint8Array, tlv: Tlv): Uint8Array {
  return buf.subarray(tlv.start + tlv.headerLength, tlv.end);
}

export function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function encodeTlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), encodeLength(value.length), value);
}

// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.of(
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
);

/** Wraps a PKCS#1 RSAPrivateKey ("BEGIN RSA PRIVATE KEY") into PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  return encodeTlv(0x30, concatBytes(version, RSA_ALGORITHM_IDENTIFIER, encodeTlv(0x04, pkcs1)));
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumberHex: string;
  notBefore: Date;
  notAfter: Date;
  /** DER SubjectPublicKeyInfo, importable with WebCrypto `importKey("spki", ...)`. */
  subjectPublicKeyInfo: Uint8Array;
}

const OID_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
};

function decodeOid(bytes: Uint8Array): string {
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function decodeName(buf: Uint8Array, name: Tlv): string {
  const rdns: string[] = [];
  for (const set of childrenOf(buf, name)) {
    for (const attr of childrenOf(buf, set)) {
      const [oidTlv, valueTlv] = childrenOf(buf, attr);
      if (!oidTlv || !valueTlv) continue;
      const oid = decodeOid(valueOf(buf, oidTlv));
      const text = new TextDecoder().decode(valueOf(buf, valueTlv));
      rdns.push(`${OID_NAMES[oid] ?? oid}=${text}`);
    }
  }
  return rdns.join(", ");
}

function decodeTime(buf: Uint8Array, tlv: Tlv): Date {
  const text = new TextDecoder().decode(valueOf(buf, tlv));
  // UTCTime: YYMMDDHHMMSSZ, GeneralizedTime: YYYYMMDDHHMMSSZ
  const m =
    tlv.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!m) throw new Error(`X.509: unsupported time format '${text}'`);
  let year = Number(m[1]);
  if (tlv.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

/** Reads the fields we need from a DER-encoded X.509 certificate. */
export function parseCertificate(der: Uint8Array): CertificateInfo {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("X.509: certificate is not a SEQUENCE");
  const [tbs] = childrenOf(der, cert);
  if (!tbs || tbs.tag !== 0x30) throw new Error("X.509: missing tbsCertificate");
  const fields = childrenOf(der, tbs);
  let i = 0;
  if (fields[i]?.tag === 0xa0) i++; // explicit [0] version
  const serial = fields[i++];
  i++; // signature AlgorithmIdentifier
  const issuer = fields[i++];
  const validity = fields[i++];
  const subject = fields[i++];
  const spki = fields[i++];
  if (!serial || !issuer || !validity || !subject || !spki) throw new Error("X.509: truncated tbsCertificate");
  const [notBefore, notAfter] = childrenOf(der, validity);
  return {
    subject: decodeName(der, subject),
    issuer: decodeName(der, issuer),
    serialNumberHex: bytesToHex(valueOf(der, serial)),
    notBefore: decodeTime(der, notBefore),
    notAfter: decodeTime(der, notAfter),
    subjectPublicKeyInfo: der.slice(spki.start, spki.end),
  };
}
