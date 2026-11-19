#!/usr/bin/env node
/**
 * Operator command for the autonomous agent: start a run, read the last runs.
 * The agent has no schedule by default, so this (or any POST /run) is what
 * makes it act.
 *
 *   npm run autonomous:run    -- --url https://agentid-cf-autonomous.<subdomain>.workers.dev
 *   npm run autonomous:status -- --url https://agentid-cf-autonomous.<subdomain>.workers.dev [--last 5]
 *
 * Authentication, matching the Worker's ADMIN_AUTH (first one found wins):
 *   AUTONOMOUS_ADMIN_KEY                       ADMIN_AUTH=admin-key: sent as x-admin-key
 *   CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  ADMIN_AUTH=access, Access service token
 *   CF_ACCESS_TOKEN (or --access-token)        ADMIN_AUTH=access, your own Access sign-in:
 *                                              export CF_ACCESS_TOKEN=$(cloudflared access token -app=<url>)
 *                                              after `cloudflared access login <url>`
 * Secrets are read from environment variables so they stay out of shell history.
 * Prints claims and results only; the agent never returns tokens.
 *
 * No npm packages; Node 22+.
 */
import { parseArgs } from "node:util";

const USAGE = `Usage:
  node scripts/client/autonomous-admin.mjs run    --url <worker url>
  node scripts/client/autonomous-admin.mjs status --url <worker url> [--last <n>]
Options: --json (raw response), --access-token <token>, --timeout <seconds> (default 180)
Environment: AUTONOMOUS_URL, AUTONOMOUS_ADMIN_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, CF_ACCESS_TOKEN`;

export function authHeaders(env, accessToken) {
  if (env.AUTONOMOUS_ADMIN_KEY) return { via: "admin key", headers: { "x-admin-key": env.AUTONOMOUS_ADMIN_KEY } };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      via: "Access service token",
      headers: { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET },
    };
  }
  const token = accessToken || env.CF_ACCESS_TOKEN;
  if (token) return { via: "Access sign-in (cloudflared)", headers: { "cf-access-token": token } };
  return { via: "none", headers: {} };
}

/** Plain-language reason for a refused request. */
export function explainFailure(status, body, url, via) {
  if (status >= 300 && status < 400) {
    return `Cloudflare Access wants a sign-in (HTTP ${status}). Run "cloudflared access login ${url}" and set CF_ACCESS_TOKEN, or use an Access service token.`;
  }
  if (status === 401) return `Not authorized (${via}): the admin key does not match the Worker's ADMIN_KEY secret.`;
  if (status === 403) {
    if (body?.error === "access_required") return "The Worker expects Cloudflare Access (ADMIN_AUTH=access), but this request did not come through Access.";
    if (body?.error === "access_denied") return "Access authenticated the request for a different Access application (check ACCESS_AUD).";
    return `Forbidden (${via}): Cloudflare Access refused the request. Check the application's policies.`;
  }
  if (status === 404) return "Not found: the admin endpoints are off (no ADMIN_KEY secret in admin-key mode) or the URL is wrong.";
  if (status === 409) return body?.error?.message ?? "A run is already in progress.";
  if (body?.error) return `${status}: ${typeof body.error === "string" ? `${body.error} ${body.message ?? ""}` : JSON.stringify(body.error)}`;
  return `HTTP ${status}`;
}

function formatRun(run) {
  const lines = [];
  const seconds = run.finishedAt ? ((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1) : "?";
  lines.push(`${run.ok ? "OK    " : "FAILED"} ${run.startedAt}  ${run.trigger}  mode=${run.mode}  ${seconds}s`);
  if (run.token) {
    const t = run.token;
    const subject = t.upn ?? t.preferred_username ?? t.oid;
    const grants = t.scp ? `scp=${t.scp}` : t.roles ? `roles=${[].concat(t.roles).join(",")}` : "";
    lines.push(`  token: aud=${t.aud} azp=${t.azp ?? t.appid} subject=${subject} ${grants}`.trimEnd());
    const facets = Object.entries(t).filter(([k]) => k.startsWith("xms_")).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    if (facets.length) lines.push(`         ${facets.join(" ")}`);
  }
  if (run.tools) lines.push(`  tools: ${run.tools.join(", ")}`);
  for (const call of run.toolCalls ?? []) lines.push(`  ${call.ok ? "called" : "FAILED"} ${call.tool} ${JSON.stringify(call.arguments)}`);
  if (run.answer) lines.push(`  answer: ${run.answer}`);
  if (run.toolResult) lines.push(`  result: ${run.toolResult.slice(0, 1500)}`);
  if (run.error) lines.push(`  error: ${JSON.stringify(run.error)}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      last: { type: "string", default: "5" },
      json: { type: "boolean", default: false },
      "access-token": { type: "string" },
      timeout: { type: "string", default: "180" },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !["run", "status"].includes(command)) {
    out.log(USAGE);
    return values.help ? 0 : 2;
  }
  const base = (values.url ?? env.AUTONOMOUS_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    out.error("Set --url (or AUTONOMOUS_URL) to the autonomous Worker, e.g. https://agentid-cf-autonomous.<subdomain>.workers.dev");
    return 2;
  }
  const auth = authHeaders(env, values["access-token"]);
  if (auth.via === "none") out.error("No credentials found (see --help); trying without.");

  const path = command === "run" ? "/run" : "/status";
  if (command === "run") out.log(`Starting a run (${auth.via}). The agent gets its own token and calls the MCP server; this can take a minute...`);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: command === "run" ? "POST" : "GET",
      headers: { accept: "application/json", ...auth.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(Number(values.timeout) * 1000),
    });
  } catch (err) {
    out.error(`Request failed: ${err.cause?.message ?? err.message}`);
    return 1;
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const isRunRecord = command === "run" && body && typeof body.startedAt === "string" && response.status !== 409;
  if (!response.ok && !isRunRecord) {
    out.error(explainFailure(response.status, body, base, auth.via));
    return 1;
  }
  if (values.json) {
    out.log(JSON.stringify(body, null, 2));
  } else if (command === "run") {
    out.log(formatRun(body));
  } else {
    const runs = (body?.runs ?? []).slice(0, Math.max(1, Number(values.last) || 5));
    out.log(runs.length ? runs.map(formatRun).join("\n\n") : "No runs yet. Start one with: npm run autonomous:run -- --url <worker url>");
  }
  return command === "run" && !body?.ok ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("autonomous-admin.mjs")) {
  main().then((code) => process.exit(code));
}
