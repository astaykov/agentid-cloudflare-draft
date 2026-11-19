#!/usr/bin/env node
/**
 * Minimal client for the interactive agent. Zero dependencies (Node.js 20+).
 *
 * Signs a user in with the CLI client app registration (authorization code + PKCE on a
 * localhost redirect, or device code), requesting api://<blueprint>/<scope>. That token's
 * audience is the agent identity blueprint, which is exactly what the agent needs for OBO.
 *
 *   node scripts/client/agent-cli.mjs login  --tenant <id> --client <cli app id> --blueprint <blueprint app id> [--agent <url>] [--device-code]
 *   node scripts/client/agent-cli.mjs whoami [--agent <url>]
 *   node scripts/client/agent-cli.mjs tools  [--agent <url>] [--json]
 *   node scripts/client/agent-cli.mjs call   --tool <name> [--server <id>] [--arg key=value ...] [--args '<json>'] [--agent <url>]
 *   node scripts/client/agent-cli.mjs chat   [--new] [--debug] [--model <id>] "How many users are in my tenant?" [--agent <url>]
 *   node scripts/client/agent-cli.mjs reset | claims | logout
 *
 * MCP servers: "enterprise" (Microsoft MCP Server for Enterprise) and, when ECHO_MCP_URL is set on
 * the agent, "echo" (the echo MCP server). Examples, the same in bash and PowerShell:
 *
 *   npm run cli -- tools
 *   npm run cli -- call --tool whoami                  (the echo server's whoami tool)
 *   npm run cli -- call --server echo --tool whoami    (the same, with the server named)
 *   npm run cli -- call --tool echo --arg message=hello
 *   npm run cli -- chat "Ask the echo server who is calling it"
 *   npm run cli -- chat --new "Ask the echo server who is calling it"   (forget the earlier turns first)
 *
 * The agent remembers your last few chat turns for 30 minutes (CHAT_MEMORY_MINUTES on the agent);
 * `chat --new` starts a new conversation, `reset` clears it. `chat --debug` also prints what the
 * model was offered and returned at each step (tool calls, its text, token counts).
 * `chat --model <id>` uses another Workers AI model for that request, if the agent's
 * AI_MODEL_CHOICES allows it (default: @cf/meta/llama-3.3-70b-instruct-fp8-fast and
 * @cf/meta/llama-4-scout-17b-16e-instruct). Compare them without redeploying:
 *
 *   npm run cli -- chat --new --debug --model @cf/meta/llama-4-scout-17b-16e-instruct "Ask the echo server who is calling it"
 *
 * --arg sends a string value and needs no JSON quoting; use --args for numbers, booleans or objects.
 * `tools --json` shows each tool's input schema (its argument names).
 *
 * ENTRA_ACCESS_TOKEN=<token> skips sign-in (bring your own token for api://<blueprint>/access_agent).
 *
 * The access token (1 hour, audience = your blueprint) is cached in .agent-cli/session.json
 * with owner-only permissions so you are not prompted on every command. `logout` deletes it;
 * `--no-cache` disables it. The token is never printed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildToolArguments } from "../lib/cli-args.mjs";
import { acquireToken, decodeJwtClaims } from "../lib/entra-login.mjs";

const SESSION_DIR = resolve(".agent-cli");
const SESSION_FILE = join(SESSION_DIR, "session.json");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string", default: process.env.ENTRA_TENANT_ID },
    client: { type: "string", default: process.env.CLI_CLIENT_ID },
    blueprint: { type: "string", default: process.env.BLUEPRINT_CLIENT_ID },
    scope: { type: "string", default: process.env.AGENT_SCOPE ?? "access_agent" },
    agent: { type: "string", default: process.env.AGENT_URL },
    tool: { type: "string" },
    server: { type: "string" },
    args: { type: "string" },
    arg: { type: "string", multiple: true },
    json: { type: "boolean", default: false },
    new: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
    model: { type: "string" },
    "device-code": { type: "boolean", default: false },
    "no-cache": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

function loadSession() {
  if (!existsSync(SESSION_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

function saveSession(session) {
  if (values["no-cache"]) return;
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  try {
    chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* Windows */
  }
}

function claimsSummary(claims) {
  if (!claims) return {};
  const { aud, iss, tid, ver, azp, oid, upn, preferred_username, name, scp, exp } = claims;
  return { aud, iss, tid, ver, azp, oid, user: preferred_username ?? upn, name, scp, expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined };
}

async function login(session) {
  const tenantId = values.tenant ?? session?.tenantId;
  const clientId = values.client ?? session?.clientId;
  const blueprint = values.blueprint ?? session?.blueprint;
  if (!tenantId || !clientId || !blueprint) {
    throw new Error("login needs --tenant, --client (CLI client app ID) and --blueprint (interactive blueprint app ID)");
  }
  const scopes = [`api://${blueprint}/${values.scope}`];
  const token = await acquireToken({
    tenantId,
    clientId,
    scopes,
    mode: values["device-code"] ? "device" : "browser",
    // ENTRA_ACCESS_TOKEN lets you bring a token obtained elsewhere, e.g.
    // az account get-access-token --scope api://<blueprint>/access_agent --query accessToken -o tsv
    allowEnvToken: true,
  });
  const next = {
    tenantId,
    clientId,
    blueprint,
    agentUrl: values.agent ?? session?.agentUrl,
    accessToken: token.accessToken,
    expiresOn: new Date(token.expiresOn).toISOString(),
  };
  saveSession(next);
  return next;
}

async function ensureSession() {
  const session = loadSession();
  if (session?.accessToken && new Date(session.expiresOn).getTime() - Date.now() > 120_000) {
    if (values.agent) session.agentUrl = values.agent;
    return session;
  }
  console.error("Signing in...");
  return login(session);
}

async function callAgent(session, method, path, body) {
  const base = (values.agent ?? session.agentUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("Pass --agent https://agentid-cf-interactive.<subdomain>.workers.dev (or set AGENT_URL)");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const challenge = response.headers.get("www-authenticate");
    console.error(`HTTP ${response.status}${challenge ? `  WWW-Authenticate: ${challenge}` : ""}`);
    console.error(JSON.stringify(data, null, 2));
    process.exitCode = 1;
    return undefined;
  }
  return data;
}

/** chat --debug: one line per model call. */
function printTrace(data) {
  if (!Array.isArray(data.trace)) {
    console.log("\n(No trace: the agent does not support --debug yet. Deploy the current version.)");
    return;
  }
  console.log(`\nModel steps (${data.model ?? "model unknown"}):`);
  for (const step of data.trace) {
    const offered = step.toolsOffered ? `${step.toolsOffered} tools offered` : "no tools offered";
    const tokens = step.promptTokens !== undefined ? `, ${step.promptTokens} prompt tokens` : "";
    let what;
    if (step.outcome === "tool_calls") {
      const calls = (step.toolCalls ?? []).map((c) => `${c.name} ${JSON.stringify(c.arguments)}`).join("; ");
      what = `called ${calls}${step.toolCallsFromText ? " (written as text, run anyway)" : ""}`;
    } else if (step.outcome === "asked_again") {
      what = "called no tool, so the agent asked once more";
    } else if (step.outcome === "empty") {
      what = "returned no text and no tool call";
    } else if (step.outcome === "call_instead_of_answer") {
      what = "wrote another tool call instead of an answer, so the answer shows the last tool result";
    } else {
      what = "answered";
    }
    console.log(`  ${step.step}. ${offered}${tokens}: ${what}`);
    if (step.text && (step.outcome !== "tool_calls" || step.toolCallsFromText)) console.log(`     it said: ${JSON.stringify(step.text)}`);
  }
}

function firstLine(text) {
  const line = String(text ?? "").split("\n")[0].trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function errorLine(error) {
  if (!error) return "unknown error";
  const parts = [error.type, error.status && `HTTP ${error.status}`, error.aadsts, error.message].filter(Boolean);
  return parts.join(": ").slice(0, 400);
}

/** Tools grouped by MCP server; older agents return a flat list. */
function printTools(data) {
  if (!Array.isArray(data.servers)) {
    for (const tool of data.tools ?? []) console.log(`- ${tool.name}: ${(tool.description ?? "").split("\n")[0]}`);
    return;
  }
  for (const server of data.servers) {
    const where = server.url ? `  ${server.url}` : "";
    if (server.error) {
      console.log(`${server.id}${where}\n  not available: ${errorLine(server.error)}`);
      continue;
    }
    console.log(`${server.id}${where}  (${server.tools} tools)`);
    for (const tool of (data.tools ?? []).filter((t) => t.server === server.id)) {
      const renamed = tool.originalName && tool.originalName !== tool.name ? ` (on the server: ${tool.originalName})` : "";
      console.log(`  - ${tool.name}${renamed}: ${(tool.description ?? "").split("\n")[0].slice(0, 140)}`);
    }
  }
}

async function main() {
  if (values.help || !command) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    return;
  }
  switch (command) {
    case "login": {
      const session = await login(loadSession());
      console.log("Signed in. Token claims (the token itself is not shown):");
      console.log(JSON.stringify(claimsSummary(decodeJwtClaims(session.accessToken)), null, 2));
      if (values["no-cache"]) console.log("(--no-cache: nothing stored; pass --no-cache to other commands too)");
      break;
    }
    case "claims": {
      const session = loadSession();
      if (!session) throw new Error("Not signed in");
      console.log(JSON.stringify(claimsSummary(decodeJwtClaims(session.accessToken)), null, 2));
      break;
    }
    case "logout":
      rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log("Removed the cached session.");
      break;
    case "whoami": {
      const data = await callAgent(await ensureSession(), "GET", "/api/whoami");
      if (data) console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "tools": {
      const data = await callAgent(await ensureSession(), "GET", "/api/tools");
      if (!data) break;
      if (values.json) console.log(JSON.stringify(data, null, 2));
      else printTools(data);
      break;
    }
    case "call": {
      if (!values.tool) throw new Error("call needs --tool <name> [--server <id>] [--arg key=value] [--args '<json>']");
      const args = buildToolArguments(values.args, values.arg ?? []);
      const body = { name: values.tool, arguments: args, ...(values.server ? { server: values.server } : {}) };
      const data = await callAgent(await ensureSession(), "POST", "/api/tools/call", body);
      if (data) console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "chat": {
      const prompt = positionals.slice(1).join(" ").trim();
      if (!prompt) throw new Error('chat needs a prompt, e.g. chat "How many users are in my tenant?"');
      const data = await callAgent(await ensureSession(), "POST", "/api/chat", {
        prompt,
        ...(values.new ? { newConversation: true } : {}),
        ...(values.debug ? { debug: true } : {}),
        ...(values.model ? { model: values.model } : {}),
      });
      if (!data) break;
      console.log(data.answer);
      if (data.toolCalls?.length) {
        console.log("\nTool calls:");
        for (const call of data.toolCalls) {
          const line = `- ${call.ok ? "ok " : "ERR"} ${call.server ? `${call.server}/` : ""}${call.tool} ${JSON.stringify(call.arguments)}`;
          console.log(call.ok ? line : `${line}\n      ${firstLine(call.preview)}`);
        }
      }
      for (const server of data.unavailableServers ?? []) {
        console.log(`\n(MCP server '${server.id}' was not available: ${errorLine(server.error)})`);
      }
      const earlier = data.conversation?.earlierTurns ?? 0;
      if (earlier > 0) {
        console.log(`\n(The agent also saw your last ${earlier} question${earlier === 1 ? "" : "s"} of this conversation. Use chat --new to start a new one.)`);
      }
      if (values.debug) printTrace(data);
      break;
    }
    case "reset": {
      const data = await callAgent(await ensureSession(), "POST", "/api/reset");
      if (data) console.log("Conversation cleared.");
      break;
    }
    default:
      throw new Error(`Unknown command '${command}'. Use --help.`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
