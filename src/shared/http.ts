import { ConfigurationError } from "./config.ts";
import { CertificateConfigurationError } from "./entra/certificate.ts";
import { TokenValidationError } from "./entra/inbound-auth.ts";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function readJsonBody(request: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "request_too_large", "Request body is too large");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Maps errors to responses without leaking internals (never includes tokens). */
export function errorResponse(err: unknown): Response {
  if (err instanceof TokenValidationError) {
    const headers: Record<string, string> = err.needsChallenge ? { "WWW-Authenticate": err.toWwwAuthenticate() } : {};
    return json({ error: err.code, message: err.message }, err.status, headers);
  }
  if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
  if (err instanceof ConfigurationError || err instanceof CertificateConfigurationError) {
    console.error(err.message);
    return json({ error: "configuration_error", message: err.message }, 500);
  }
  console.error("Unhandled error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  return json({ error: "internal_error", message: "Unexpected error. See the Worker logs." }, 500);
}

/** Constant-time comparison of two secrets (hash first so lengths match). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length > 0;
}
