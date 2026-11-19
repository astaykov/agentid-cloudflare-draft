/**
 * Zero-dependency sign-in to Microsoft Entra ID for the sample's command-line
 * tools. Node.js 20+ built-ins only: nothing from a package feed.
 *
 * Used by scripts/entra/setup-entra.mjs (Microsoft Graph, delegated) and
 * scripts/client/agent-cli.mjs (the interactive agent's API).
 *
 *   import { acquireToken, publicClaims } from "../lib/entra-login.mjs";
 *   const { accessToken, expiresOn, claims } = await acquireToken({
 *     tenantId: "<tenant GUID>",
 *     clientId: "<public client app ID>",
 *     scopes: ["https://graph.microsoft.com/User.Read"],
 *     mode: "browser", // or "device"
 *   });
 *
 * Flows (public client: no client secret, no certificate):
 *   "browser"  OAuth 2.0 authorization code flow with PKCE (S256) and a loopback
 *              redirect: a one-shot HTTP listener on 127.0.0.1 (random port)
 *              receives the code at http://localhost:<port>. The app registration
 *              needs the redirect URI "http://localhost" (platform "Mobile and
 *              desktop applications"); Entra accepts any port for it.
 *   "device"   OAuth 2.0 device authorization grant (RFC 8628) for machines
 *              without a browser. The app registration needs "Allow public client
 *              flows"; Conditional Access policies often block this flow.
 *
 * ENTRA_ACCESS_TOKEN: if the caller passes `allowEnvToken: true` and this
 * environment variable is set, its value is returned without any sign-in. Use it
 * when you paste a token obtained elsewhere, for example from Graph Explorer
 * ("Access token" tab). It must be issued for the same tenant and the right
 * resource, and it is not refreshed (Graph Explorer tokens last about an hour).
 *
 * Secrets hygiene: this module never prints, logs or stores access tokens,
 * refresh tokens, authorization codes or device codes. It does not request
 * offline_access, so Entra issues no refresh token. The access token is only
 * returned to the caller; to show who signed in, print publicClaims(claims)
 * (upn, oid, tid, scp), never the token.
 *
 * Corporate networks:
 *   - Proxies: Node's built-in fetch honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 *     only when NODE_USE_ENV_PROXY=1 is set (Node.js 24+). Otherwise it connects
 *     directly.
 *   - TLS inspection: set NODE_EXTRA_CA_CERTS to a PEM file containing the
 *     proxy's root CA, so Node trusts the re-signed certificates.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 60_000;

/** Hints for frequent AADSTS codes, appended to error messages. */
const AADSTS_HINTS = {
  50011: "The redirect URI is not registered. Add http://localhost as a 'Mobile and desktop applications' redirect URI on the app registration.",
  500113: "The app registration has no redirect URI. Add http://localhost as a 'Mobile and desktop applications' redirect URI.",
  50020: "The account belongs to another tenant and is not a guest in this one. Sign in with an account of the tenant.",
  50059: "Tenant not found. Check the tenant ID.",
  90002: "Tenant not found. Check the tenant ID.",
  700016: "The client application was not found in this tenant. Check the client ID and the tenant ID.",
  7000218: "The app registration is not a public client. Enable 'Allow public client flows' (isFallbackPublicClient) on it.",
  65001: "Consent is missing. Sign in as an administrator and accept the consent prompt, or ask an administrator to grant consent.",
  65004: "The consent prompt was declined.",
  90094: "Admin consent is required for at least one requested permission. Sign in as an administrator or ask one to grant consent.",
  70011: "A requested scope is invalid. Check the scope names and that the API exists in this tenant.",
  500011: "The resource (API) was not found in this tenant. Check the scope's app ID URI and that the API has a service principal here.",
  650057: "The client app does not list this API permission. Add it under 'API permissions' (or re-run scripts/entra/setup-entra.mjs).",
  50105: "The signed-in user is not assigned to the application (user assignment is required).",
  53003: "Blocked by Conditional Access. The device code flow is often blocked; try the browser flow, or ask your administrator.",
  70008: "The authorization code or session expired. Sign in again.",
  54005: "The authorization code was already redeemed. Sign in again.",
};

/** Sign-in failure with Entra's OAuth error details. Never contains tokens or codes. */
export class EntraLoginError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "EntraLoginError";
    this.status = details.status;
    this.error = details.error;
    this.errorDescription = details.errorDescription;
    this.errorCodes = details.errorCodes;
    this.correlationId = details.correlationId;
    this.traceId = details.traceId;
  }
}

// ---------------------------------------------------------------- PKCE, URLs and claims

/** RFC 7636 S256 code challenge: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallengeS256(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A fresh PKCE pair. 32 random bytes give a 43-character verifier (RFC 7636 section 4.1). */
export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallengeS256(verifier) };
}

/** Accepts an array or a space/comma separated string; returns unique, trimmed scopes. */
export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes ?? "").split(/[\s,]+/);
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

/** Builds the /authorize URL for the authorization code + PKCE flow. */
export function buildAuthorizeUrl({
  authorityHost = DEFAULT_AUTHORITY_HOST,
  tenantId,
  clientId,
  redirectUri,
  scopes,
  state,
  codeChallenge,
  loginHint,
  prompt = "select_account",
}) {
  const url = new URL(`${authorityUrl(authorityHost, tenantId)}/oauth2/v2.0/authorize`);
  const params = url.searchParams;
  params.set("client_id", clientId);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("response_mode", "query");
  params.set("scope", normalizeScopes(scopes).join(" "));
  params.set("state", state);
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  if (prompt) params.set("prompt", prompt);
  if (loginHint) params.set("login_hint", loginHint);
  return url.toString();
}

/**
 * Decodes a JWT's payload WITHOUT validating it (display purposes only).
 * Returns undefined for anything that is not a readable JWS, e.g. an encrypted token.
 */
export function decodeJwtClaims(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** The non-secret claims that identify a delegated token: upn, oid, tid and scp. */
export function publicClaims(claims) {
  if (!claims) return undefined;
  return {
    upn: claims.upn ?? claims.preferred_username ?? claims.unique_name ?? claims.email,
    oid: claims.oid,
    tid: claims.tid,
    scp: typeof claims.scp === "string" ? claims.scp.split(" ").filter(Boolean) : [],
  };
}

/**
 * Explains a fetch() failure (DNS, proxy, TLS inspection, timeout).
 * `transient` is true when retrying the same request may succeed.
 */
export function describeNetworkError(err) {
  const cause = err?.cause ?? err;
  const code = String(cause?.code ?? err?.name ?? "NETWORK_ERROR");
  const tls = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/i.test(code);
  const detail = cause && cause !== err && cause.message ? ` (${cause.message})` : "";
  return {
    code,
    message: `${err?.message ?? "network error"}${detail}`,
    transient: /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|TimeoutError/i.test(code),
    hint: tls
      ? "TLS verification failed. Behind a TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS to the proxy's root CA certificate (PEM file)."
      : "Check the network connection. Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 (Node.js 24+); otherwise Node's fetch ignores proxy variables.",
  };
}

// ---------------------------------------------------------------- public entry point

/**
 * Signs the user in and returns a delegated access token.
 *
 * @param {object}   options
 * @param {string}   options.tenantId      Tenant ID (GUID) or verified domain name.
 * @param {string}   options.clientId      Application (client) ID of a PUBLIC client app registration.
 * @param {string[]|string} options.scopes Scopes, e.g. ["https://graph.microsoft.com/User.Read"] or ["api://<app>/access_agent"].
 * @param {"browser"|"device"} [options.mode="browser"]
 * @param {string}   [options.loginHint]   Pre-fills the account (browser mode).
 * @param {boolean}  [options.openBrowser=true] false: print the sign-in URL instead of opening it.
 * @param {number}   [options.timeoutMs=300000] Maximum time to wait for the user (both modes).
 * @param {boolean}  [options.allowEnvToken=false] Return ENTRA_ACCESS_TOKEN if it is set.
 * @param {string}   [options.authorityHost] Default https://login.microsoftonline.com (sovereign clouds differ).
 * @param {(message: string) => void} [options.log] Where instructions go (default: stderr).
 * @returns {Promise<{accessToken: string, expiresOn: Date, claims: object|undefined, scopes: string[], source: "browser"|"device"|"environment"}>}
 *          `claims` is the decoded (not validated) JWT payload. Never print `accessToken`.
 */
export async function acquireToken({
  tenantId,
  clientId,
  scopes,
  mode = "browser",
  loginHint,
  openBrowser = true,
  timeoutMs = 300_000,
  allowEnvToken = false,
  authorityHost = DEFAULT_AUTHORITY_HOST,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (typeof fetch !== "function") throw new Error("Node.js 20 or later is required (global fetch).");
  if (!tenantId || /[\s/?#]/.test(tenantId)) throw new TypeError("acquireToken: tenantId must be a tenant ID (GUID) or domain name");
  if (!GUID.test(clientId ?? "")) throw new TypeError("acquireToken: clientId must be an application (client) ID GUID");
  const scopeList = normalizeScopes(scopes);
  if (scopeList.length === 0) throw new TypeError("acquireToken: at least one scope is required");
  if (mode !== "browser" && mode !== "device") throw new TypeError('acquireToken: mode must be "browser" or "device"');
  if (!(timeoutMs > 0)) throw new TypeError("acquireToken: timeoutMs must be a positive number");

  if (allowEnvToken) {
    const fromEnv = tokenFromEnvironment(tenantId, log);
    if (fromEnv) return fromEnv;
  }
  const authority = authorityUrl(authorityHost, tenantId);
  const options = { authority, authorityHost, tenantId, clientId, scopes: scopeList, loginHint, openBrowser, timeoutMs, log };
  return mode === "device" ? loginWithDeviceCode(options) : loginWithBrowser(options);
}

// ---------------------------------------------------------------- ENTRA_ACCESS_TOKEN

/** Returns the token from ENTRA_ACCESS_TOKEN (pasted, e.g. from Graph Explorer), or undefined. */
function tokenFromEnvironment(tenantId, log) {
  const raw = (process.env.ENTRA_ACCESS_TOKEN ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!raw) return undefined;
  const claims = decodeJwtClaims(raw);
  if (claims?.exp && claims.exp * 1000 <= Date.now() + 60_000) {
    throw new EntraLoginError(
      `ENTRA_ACCESS_TOKEN expired at ${new Date(claims.exp * 1000).toISOString()}. Paste a fresh token, or unset the variable to sign in interactively.`,
    );
  }
  if (claims?.tid && GUID.test(tenantId) && claims.tid.toLowerCase() !== tenantId.toLowerCase()) {
    throw new EntraLoginError(`ENTRA_ACCESS_TOKEN was issued by tenant ${claims.tid}, not by ${tenantId}.`);
  }
  log("Using the access token from the ENTRA_ACCESS_TOKEN environment variable (no sign-in).");
  return {
    accessToken: raw,
    // A pasted JWT always carries exp; one hour is the usual lifetime otherwise.
    expiresOn: claims?.exp ? new Date(claims.exp * 1000) : new Date(Date.now() + 3600_000),
    claims,
    scopes: publicClaims(claims)?.scp ?? [],
    source: "environment",
  };
}

// ---------------------------------------------------------------- authorization code + PKCE

async function loginWithBrowser({ authority, authorityHost, tenantId, clientId, scopes, loginHint, openBrowser, timeoutMs, log }) {
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // Entra matches the registered "http://localhost" redirect URI for any port.
  const redirectUri = `http://localhost:${server.address().port}`;
  let url;
  try {
    url = buildAuthorizeUrl({ authorityHost, tenantId, clientId, redirectUri, scopes, state, codeChallenge: challenge, loginHint });
  } catch (err) {
    server.close();
    throw err;
  }

  const codeReceived = waitForAuthorizationCode(server, state, timeoutMs);
  if (openBrowser) {
    log("Opening your browser to sign in...");
    openInBrowser(url, (reason) => log(`Could not open a browser (${reason}). Open this URL on this machine to sign in:\n${url}`));
  } else {
    log(`Open this URL in a browser on this machine to sign in:\n${url}`);
  }
  const code = await codeReceived;

  const response = await postForm(`${authority}/oauth2/v2.0/token`, {
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: scopes.join(" "),
  });
  if (!response.ok) throw entraError("Token request failed", response);
  return toTokenResult(response.body, "browser");
}

/**
 * Serves the loopback redirect until Entra sends the authorization code (or an
 * error), shows a small page in the browser, then closes the server.
 */
function waitForAuthorizationCode(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(code);
    };
    const timer = setTimeout(
      () => finish(new EntraLoginError(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the browser sign-in to finish.`)),
      timeoutMs,
    );

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const params = url.searchParams;
      if (req.method !== "GET" || url.pathname !== "/" || (!params.has("code") && !params.has("error"))) {
        sendPage(res, 404, "Not found", "This address only receives the Microsoft Entra sign-in response.");
        return;
      }
      if (settled) {
        sendPage(res, 409, "Sign-in already handled", "You can close this window.");
        return;
      }
      if (params.get("state") !== expectedState) {
        sendPage(res, 400, "Sign-in failed", "The response did not match this sign-in request. Check the terminal.", () =>
          finish(new EntraLoginError("The sign-in response carried an unexpected state value, so it was rejected. Run the command again.")),
        );
        return;
      }
      if (params.has("error")) {
        const body = { error: params.get("error"), error_description: params.get("error_description") ?? "" };
        sendPage(res, 400, "Sign-in failed", `${body.error}: ${firstLine(body.error_description)}`, () =>
          finish(entraError("Sign-in failed", { status: 400, body })),
        );
        return;
      }
      sendPage(res, 200, "Signed in.", "You can close this window.", () => finish(undefined, params.get("code")));
    });
  });
}

/** Writes a tiny HTML page; `then` runs once the response is flushed. */
function sendPage(res, status, title, message, then) {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  res.end(html, then);
}

/**
 * Opens a URL in the default browser. `onFailure(reason)` runs if that is not
 * possible (no browser, headless machine), so the caller can print the URL.
 */
export function openInBrowser(url, onFailure = () => {}) {
  let failed = false;
  const fail = (reason) => {
    if (failed) return;
    failed = true;
    onFailure(reason);
  };
  let href;
  try {
    href = new URL(url).href;
  } catch {
    fail("invalid URL");
    return;
  }
  // The URL ends up on a command line: allow http(s) only, without quotes or whitespace.
  if (!/^https?:\/\//i.test(href) || /["\s]/.test(href)) {
    fail("refusing to open an unexpected URL");
    return;
  }
  const options = { detached: true, stdio: "ignore", windowsHide: true };
  let command;
  let args;
  if (process.platform === "win32") {
    // `start` takes the first quoted argument as the window title, hence the empty "".
    // The URL is quoted (verbatim arguments) because cmd.exe would otherwise split it at each '&'.
    command = "cmd";
    args = ["/c", "start", '""', `"${href}"`];
    options.windowsVerbatimArguments = true;
  } else if (process.platform === "darwin") {
    command = "open";
    args = [href];
  } else {
    command = "xdg-open";
    args = [href];
  }
  let child;
  try {
    child = spawn(command, args, options);
  } catch (err) {
    fail(`${command}: ${err.message}`);
    return;
  }
  child.once("error", (err) => fail(`${command}: ${err.code ?? err.message}`));
  child.once("exit", (code) => {
    if (code) fail(`${command} exited with code ${code}`);
  });
  child.unref();
}

// ---------------------------------------------------------------- device code

async function loginWithDeviceCode({ authority, clientId, scopes, timeoutMs, log }) {
  const start = await postForm(`${authority}/oauth2/v2.0/devicecode`, { client_id: clientId, scope: scopes.join(" ") });
  if (!start.ok || !start.body?.device_code) throw entraError("Device code request failed", start);
  const device = start.body;
  // The message contains the URL and the user code the person has to type; both are meant to be shown.
  log(device.message ?? `To sign in, open ${device.verification_uri} and enter the code ${device.user_code}.`);

  let intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
  const waitMs = Math.min(timeoutMs, (Number(device.expires_in) || 900) * 1000);
  const deadline = Date.now() + waitMs;
  let networkFailures = 0;
  for (;;) {
    await sleep(intervalMs);
    let response;
    try {
      response = await postForm(`${authority}/oauth2/v2.0/token`, {
        grant_type: DEVICE_CODE_GRANT,
        client_id: clientId,
        device_code: device.device_code,
      });
      networkFailures = 0;
    } catch (err) {
      if (++networkFailures >= 3 || Date.now() >= deadline) throw err;
      continue;
    }
    if (response.ok) return toTokenResult(response.body, "device");

    const details = errorDetails(response);
    switch (response.body?.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += 5000;
        break;
      case "expired_token":
        throw new EntraLoginError("The device code expired before the sign-in finished. Run the command again.", details);
      case "authorization_declined":
        throw new EntraLoginError("The sign-in was declined.", details);
      case "bad_verification_code":
        throw new EntraLoginError("Entra did not recognise the device code. Run the command again.", details);
      default:
        throw entraError("Device code sign-in failed", response);
    }
    if (Date.now() >= deadline) {
      throw new EntraLoginError(`Timed out after ${Math.round(waitMs / 1000)} s waiting for the device code sign-in.`, details);
    }
  }
}

// ---------------------------------------------------------------- HTTP helpers

/** POSTs a form to Entra. Returns { ok, status, body }; throws EntraLoginError on network failures. */
async function postForm(url, params) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const network = describeNetworkError(err);
    throw new EntraLoginError(`Cannot reach ${new URL(url).host}: ${network.message}\nHint: ${network.hint}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: `HTTP ${response.status}`, error_description: text.slice(0, 300) };
  }
  return { ok: response.ok, status: response.status, body };
}

function toTokenResult(body, source) {
  if (!body?.access_token) throw new EntraLoginError("The token response did not contain an access token.");
  const claims = decodeJwtClaims(body.access_token);
  const expiresIn = Number(body.expires_in);
  let expiresOn;
  if (expiresIn > 0) expiresOn = new Date(Date.now() + expiresIn * 1000);
  else if (claims?.exp) expiresOn = new Date(claims.exp * 1000);
  else expiresOn = new Date(Date.now() + 3600_000);
  // Only the access token leaves this module; id_token / refresh_token (if any) are dropped.
  return {
    accessToken: body.access_token,
    expiresOn,
    claims,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
    source,
  };
}

function errorDetails({ status, body }) {
  return {
    status,
    error: body?.error,
    errorDescription: body?.error_description,
    errorCodes: body?.error_codes,
    correlationId: body?.correlation_id,
    traceId: body?.trace_id,
  };
}

/** "<context>: <error> - AADSTSxxxx: <first line>" plus a hint and the correlation ID. */
function entraError(context, response) {
  const details = errorDetails(response);
  const description = firstLine(details.errorDescription);
  const code = details.errorCodes?.[0] ?? Number(/AADSTS(\d+)/.exec(description ?? "")?.[1]);
  let message = `${context}: ${details.error ?? `HTTP ${details.status}`}${description ? ` - ${description}` : ""}`;
  if (AADSTS_HINTS[code]) message += `\nHint: ${AADSTS_HINTS[code]}`;
  if (details.correlationId) message += `\n(correlation ID ${details.correlationId}${details.traceId ? `, trace ID ${details.traceId}` : ""})`;
  return new EntraLoginError(message, details);
}

// ---------------------------------------------------------------- small utilities

function authorityUrl(authorityHost, tenantId) {
  return `${String(authorityHost).replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}`;
}

/** Entra appends "Trace ID / Correlation ID / Timestamp" lines to error_description. */
function firstLine(text) {
  return String(text ?? "").split(/\r?\n/)[0].trim();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
