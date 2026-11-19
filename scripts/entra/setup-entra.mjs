#!/usr/bin/env node
/**
 * Creates, idempotently, everything in Microsoft Entra ID that the agentid-cloudflare
 * sample needs, with Microsoft Graph v1.0 REST calls and a DELEGATED token.
 * Zero dependencies: Node.js 20+ built-ins only (no SDK, no PowerShell module,
 * nothing from a package feed).
 *
 *   node scripts/entra/setup-entra.mjs --config scripts/entra/entra.config.json
 *        [--only interactive|autonomous|echo] [--dry-run] [--device-code]
 *        [--state scripts/entra/.entra-state.json] [--out scripts/entra/out] [--verbose]
 *
 * Sections (enable them in the config; --only picks some, repeatable or comma separated):
 *   interactive  blueprint + blueprint principal + certificate + exposed scope (access_agent),
 *                agent identity, admin grant to MCP Server for Enterprise (used with OBO),
 *                and the public client app registration used by scripts/client/agent-cli.mjs
 *   autonomous   blueprint + blueprint principal + certificate, agent identity, and optionally
 *                an agent user with its own grant to MCP Server for Enterprise (and,
 *                optionally, the Directory Readers role)
 *   echo         optional Entra-protected echo MCP server app (delegated scope + app role,
 *                and the Agent ID optional claims xms_par_app_azp, xms_act_fct, xms_sub_fct,
 *                xms_tnt_fct and idtyp in its access tokens) and its grants to the agent
 *                identities and the agent user
 *
 * Sign-in: browser (authorization code + PKCE) or --device-code, as the public client
 * "Microsoft Graph Command Line Tools" (graphClientId in the config). To skip sign-in, set
 * ENTRA_ACCESS_TOKEN to a delegated Microsoft Graph token for the same tenant (for example
 * from Graph Explorer). Tokens are never printed or written to disk.
 *
 * Idempotent: object IDs (no secrets) are recorded in the state file, keyed by tenant, and
 * objects are looked up before they are created. Requests are retried with exponential
 * backoff (2, 4, 8, 16, 32 s, honouring Retry-After) on throttling, server errors and the
 * "does not exist" errors Entra returns while a new object replicates.
 *
 * Certificates: a PATCH of keyCredentials replaces all of a blueprint's certificates and
 * Graph never returns existing key values, so the certificate is only PATCHed onto a
 * blueprint that has none. If the blueprint already has another certificate, the script
 * leaves it alone and prints a manual step (exit code 2).
 *
 * Output: the values for each Worker's wrangler.jsonc "vars", printed and written (no
 * secrets) to scripts/entra/out/<tenantId>.json.
 *
 * Exit codes: 0 done, 1 error, 2 done but a manual step is required (printed at the end).
 */
import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireToken, describeNetworkError, EntraLoginError, publicClaims } from "../lib/entra-login.mjs";
import { AGENT_ACCESS_TOKEN_CLAIMS, mergeAgentClaims } from "../lib/agent-claims.mjs";

// ---------------------------------------------------------------- constants

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_CONFIG = join(SCRIPT_DIR, "entra.config.json");
const DEFAULT_STATE = join(SCRIPT_DIR, ".entra-state.json");
const DEFAULT_OUT_DIR = join(SCRIPT_DIR, "out");

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_RESOURCE = "https://graph.microsoft.com";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const GRAPH_CLI_TOOLS_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const MCP_SERVER_APP_ID = "e8c77dc2-69b3-43f4-bc51-3213c9d915b4";
const DIRECTORY_READERS_ROLE_ID = "88d8e3e3-8f55-4a1e-953a-9b9898b8876b";
const SECTIONS = ["interactive", "autonomous", "echo"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [2, 4, 8, 16, 32];
const REQUEST_TIMEOUT_MS = 100_000;
// Replication errors right after a create (Agent ID FAQ: back off on "Object with id ... not found").
const NOT_FOUND_PATTERN =
  /not found|does not exist|does not reference a valid application object|invalid value specified for property '(clientId|resourceId|principalId)'/i;
const CONFLICT_PATTERN = /already exists|conflicting object|same value for property/i;

/** Delegated Microsoft Graph permissions requested for every run. */
const BASE_SCOPES = [
  "User.Read",
  "AgentIdentityBlueprint.Create",
  "AgentIdentityBlueprint.AddRemoveCreds.All",
  "AgentIdentityBlueprint.UpdateAuthProperties.All",
  "AgentIdentityBlueprintPrincipal.Create",
  "AgentIdentity.Create.All",
  "Application.ReadWrite.All",
  "DelegatedPermissionGrant.ReadWrite.All",
];

/** What each kind of request needs; shown with 403 errors. */
const NEEDS = {
  me: "Needs the User.Read delegated permission and a delegated (user) token.",
  blueprint: "Needs the AgentIdentityBlueprint.Create delegated permission and the Agent ID Administrator role.",
  blueprintPrincipal: "Needs AgentIdentityBlueprintPrincipal.Create and the Agent ID Administrator role.",
  blueprintAuth: "Needs AgentIdentityBlueprint.UpdateAuthProperties.All and the Agent ID Administrator role.",
  certificate: "Needs AgentIdentityBlueprint.AddRemoveCreds.All and the Agent ID Administrator role.",
  agentIdentity: "Needs AgentIdentity.Create.All and the Agent ID Administrator role.",
  agentUser:
    "Needs AgentIdUser.ReadWrite.IdentityParentedBy and the Agent ID Administrator role. Agent users are available only to tenants in the Frontier preview program, the userPrincipalName domain must be verified, and an agent identity can have only one agent user.",
  app: "Needs Application.ReadWrite.All and the Cloud Application Administrator or Application Administrator role.",
  grant: "Needs DelegatedPermissionGrant.ReadWrite.All and the Cloud Application Administrator or Application Administrator role.",
  appRole: "Needs AppRoleAssignment.ReadWrite.All and the Privileged Role Administrator role.",
  directoryRole: "Needs RoleManagement.ReadWrite.Directory and the Privileged Role Administrator role.",
};

/** Defaults; they match entra.config.example.json. */
const DEFAULTS = {
  graphClientId: GRAPH_CLI_TOOLS_CLIENT_ID,
  mcpServer: { appId: MCP_SERVER_APP_ID, delegatedScopes: ["MCP.User.Read.All", "MCP.GroupMember.Read.All"] },
  interactive: {
    blueprintName: "agentid-cf-interactive-blueprint",
    agentIdentityName: "agentid-cf-interactive-agent",
    certificatePath: "certs/interactive-blueprint/interactive-blueprint.cer",
    scopeValue: "access_agent",
    clientAppName: "agentid-cf-cli-client",
  },
  autonomous: {
    blueprintName: "agentid-cf-autonomous-blueprint",
    agentIdentityName: "agentid-cf-autonomous-agent",
    certificatePath: "certs/autonomous-blueprint/autonomous-blueprint.cer",
  },
  agentUser: { displayName: "Cloudflare autonomous agent", mailNickname: "agentid-cf-autonomous" },
  echo: { appName: "agentid-cf-echo-mcp", scopeValue: "Echo.Read", appRoleValue: "Echo.Read.All" },
};

const KNOWN_KEYS = {
  "": ["tenantId", "sponsorUserId", "graphClientId", "mcpServer", "interactive", "autonomous", "echo"],
  mcpServer: ["appId", "delegatedScopes"],
  interactive: ["enabled", "blueprintName", "agentIdentityName", "certificatePath", "scopeValue", "clientAppName"],
  autonomous: ["enabled", "blueprintName", "agentIdentityName", "certificatePath", "agentUser"],
  "autonomous.agentUser": ["enabled", "userPrincipalName", "displayName", "mailNickname", "assignDirectoryReaders"],
  echo: ["enabled", "appName", "scopeValue", "appRoleValue"],
};

const USAGE = `Usage: node scripts/entra/setup-entra.mjs [--config <file>] [options]

Creates or updates, idempotently, the Microsoft Entra objects of the agentid-cloudflare
sample with Microsoft Graph (delegated permissions of the signed-in administrator).

Options:
  -c, --config <file>  Configuration (default: scripts/entra/entra.config.json;
                       copy scripts/entra/entra.config.example.json to start)
  --only <sections>    interactive, autonomous and/or echo; repeat or comma-separate
                       (default: every section enabled in the config)
  --dry-run            Print every Graph request (method, URL, body) with placeholder ids;
                       no sign-in, no network, no files written
  --device-code        Sign in with the device code flow instead of a browser
  --state <file>       Object ids created so far, keyed by tenant (no secrets)
                       (default: scripts/entra/.entra-state.json)
  --out <dir>          Where <tenantId>.json with the Worker values is written
                       (default: scripts/entra/out)
  -v, --verbose        Print each Graph request (method and URL) as it is sent
  -h, --help           Show this help

Sign-in uses the public client "Microsoft Graph Command Line Tools" unless graphClientId is
set. To skip sign-in, set ENTRA_ACCESS_TOKEN to a delegated Microsoft Graph token for the
same tenant (for example from Graph Explorer).

Exit codes: 0 done, 1 error, 2 done but a manual step is required.`;

// ---------------------------------------------------------------- errors and output

/** A problem the user has to fix (config, ambiguity, ...), with an optional hint. */
export class SetupError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "SetupError";
    this.hint = hint;
  }
}

/** A failed Microsoft Graph request (status 0 = network error). Never contains the token. */
export class GraphError extends Error {
  constructor({ step, method, url, status, code, message, details = [], requestId, date, hint, hint400 }) {
    super(message);
    this.name = "GraphError";
    Object.assign(this, { step, method, url, status, code, details, requestId, date, hint, hint400 });
  }
}

function report(kind, text) {
  console.log(`  ${`[${kind}]`.padEnd(10)}${text}`);
}

/** Step titles are printed in --dry-run and --verbose mode, above the requests. */
function title(ctx, text) {
  if (ctx.dryRun || ctx.verbose) console.log(`  - ${text}`);
}

function warn(ctx, text) {
  ctx.warnings.push(text);
  report("warn", text);
}

/** Something the script deliberately did not do and the user must do by hand. */
function requireAction(ctx, text) {
  ctx.actions.push(text);
  report("action", text);
}

function displayPath(file) {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function shortError(err) {
  if (err instanceof GraphError) return err.status ? `HTTP ${err.status} ${err.code}: ${err.message}` : `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const odataString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const userRef = (id) => `${GRAPH}/users/${id}`;
const splitScopes = (scope) => String(scope ?? "").split(/\s+/).filter(Boolean);
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));
// Writable properties only (Graph also returns read-only ones such as "origin").
const cleanPermissionScope = (scope) =>
  pick(scope, ["adminConsentDescription", "adminConsentDisplayName", "id", "isEnabled", "type", "userConsentDescription", "userConsentDisplayName", "value"]);
const cleanAppRole = (role) => pick(role, ["allowedMemberTypes", "description", "displayName", "id", "isEnabled", "value"]);

// ---------------------------------------------------------------- CLI

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c" },
      only: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      "device-code": { type: "boolean", default: false },
      state: { type: "string" },
      out: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    help: values.help,
    configFile: values.config ? resolve(values.config) : DEFAULT_CONFIG,
    only: values.only?.flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase()).filter(Boolean),
    dryRun: values["dry-run"],
    deviceCode: values["device-code"],
    stateFile: values.state ? resolve(values.state) : DEFAULT_STATE,
    outDir: values.out ? resolve(values.out) : DEFAULT_OUT_DIR,
    verbose: values.verbose,
  };
}

// ---------------------------------------------------------------- configuration

function loadConfig(file, { dryRun }) {
  if (!existsSync(file)) {
    throw new SetupError(
      `Config file not found: ${displayPath(file)}`,
      "Copy scripts/entra/entra.config.example.json to scripts/entra/entra.config.json, edit it, and pass --config <file>.",
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new SetupError(`${displayPath(file)} is not valid JSON: ${err.message}`);
  }
  const { config, problems, warnings } = validateConfig(raw, { dryRun });
  if (problems.length) {
    throw new SetupError(`Invalid configuration in ${displayPath(file)}:\n${problems.map((p) => `       - ${p}`).join("\n")}`);
  }
  return { config, warnings };
}

/**
 * Validates the configuration and applies defaults. A missing section is disabled.
 * @returns {{config: object, problems: string[], warnings: string[]}}
 */
export function validateConfig(raw, { dryRun = false } = {}) {
  const problems = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { config: undefined, problems: ["the file must contain a JSON object"], warnings };

  const guid = (value, name, fallback) => {
    if (value === undefined || value === null || value === "") {
      if (fallback === undefined) problems.push(`${name} is required (a GUID)`);
      return fallback;
    }
    if (typeof value === "string" && GUID.test(value)) return value.toLowerCase();
    problems.push(`${name} must be a GUID, got ${JSON.stringify(value)}`);
    return undefined;
  };
  const text = (value, name, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.trim() || value.length > 256) {
      problems.push(`${name} must be a non-empty string of at most 256 characters`);
      return fallback;
    }
    return value.trim();
  };
  const flag = (value, name, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") problems.push(`${name} must be true or false`);
    return value === true;
  };
  const permission = (value, name, fallback) => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "string" || !/^[^\s.]\S{0,119}$/.test(result)) {
      problems.push(`${name} must be a permission value without spaces that does not start with '.', got ${JSON.stringify(value)}`);
    }
    return result;
  };
  const section = (value, name) => {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) problems.push(`${name} must be an object`);
    return isPlainObject(value) ? value : undefined;
  };
  const unknownKeys = (object, path) => {
    for (const key of Object.keys(object ?? {})) {
      if (!key.startsWith("_") && !KNOWN_KEYS[path].includes(key)) warnings.push(`unknown setting ${path ? `${path}.` : ""}${key} (ignored)`);
    }
  };
  unknownKeys(raw, "");

  const config = {};
  if (typeof raw.tenantId === "string" && GUID.test(raw.tenantId)) config.tenantId = raw.tenantId.toLowerCase();
  else problems.push(`tenantId must be your directory (tenant) ID, a GUID (Entra admin center > Overview); got ${JSON.stringify(raw.tenantId)}`);
  config.sponsorUserId = guid(raw.sponsorUserId, "sponsorUserId", null);
  config.graphClientId = guid(raw.graphClientId, "graphClientId", DEFAULTS.graphClientId);

  const mcp = section(raw.mcpServer, "mcpServer") ?? {};
  unknownKeys(mcp, "mcpServer");
  const delegatedScopes = mcp.delegatedScopes ?? DEFAULTS.mcpServer.delegatedScopes;
  if (!Array.isArray(delegatedScopes) || delegatedScopes.some((s) => typeof s !== "string" || !/^\S+$/.test(s))) {
    problems.push('mcpServer.delegatedScopes must be an array of scope names without spaces, e.g. ["MCP.User.Read.All"]');
  }
  config.mcpServer = {
    appId: guid(mcp.appId, "mcpServer.appId", DEFAULTS.mcpServer.appId),
    delegatedScopes: Array.isArray(delegatedScopes) ? [...new Set(delegatedScopes)] : [],
  };

  const interactive = section(raw.interactive, "interactive");
  unknownKeys(interactive, "interactive");
  const di = DEFAULTS.interactive;
  config.interactive = {
    enabled: interactive ? flag(interactive.enabled, "interactive.enabled", true) : false,
    blueprintName: text(interactive?.blueprintName, "interactive.blueprintName", di.blueprintName),
    agentIdentityName: text(interactive?.agentIdentityName, "interactive.agentIdentityName", di.agentIdentityName),
    certificatePath: text(interactive?.certificatePath, "interactive.certificatePath", di.certificatePath),
    scopeValue: permission(interactive?.scopeValue, "interactive.scopeValue", di.scopeValue),
    clientAppName: text(interactive?.clientAppName, "interactive.clientAppName", di.clientAppName),
  };

  const autonomous = section(raw.autonomous, "autonomous");
  unknownKeys(autonomous, "autonomous");
  const da = DEFAULTS.autonomous;
  config.autonomous = {
    enabled: autonomous ? flag(autonomous.enabled, "autonomous.enabled", true) : false,
    blueprintName: text(autonomous?.blueprintName, "autonomous.blueprintName", da.blueprintName),
    agentIdentityName: text(autonomous?.agentIdentityName, "autonomous.agentIdentityName", da.agentIdentityName),
    certificatePath: text(autonomous?.certificatePath, "autonomous.certificatePath", da.certificatePath),
  };
  const agentUser = section(autonomous?.agentUser, "autonomous.agentUser");
  unknownKeys(agentUser, "autonomous.agentUser");
  config.autonomous.agentUser = {
    enabled: agentUser ? flag(agentUser.enabled, "autonomous.agentUser.enabled", true) : false,
    userPrincipalName: agentUser?.userPrincipalName,
    displayName: text(agentUser?.displayName, "autonomous.agentUser.displayName", DEFAULTS.agentUser.displayName),
    mailNickname: agentUser?.mailNickname ?? DEFAULTS.agentUser.mailNickname,
    assignDirectoryReaders: flag(agentUser?.assignDirectoryReaders, "autonomous.agentUser.assignDirectoryReaders", false),
  };
  if (config.autonomous.enabled && config.autonomous.agentUser.enabled) {
    const { userPrincipalName: upn, mailNickname } = config.autonomous.agentUser;
    if (typeof upn !== "string" || !/^[^@\s]+@[^@\s]+$/.test(upn)) {
      problems.push(`autonomous.agentUser.userPrincipalName must look like name@your-verified-domain, got ${JSON.stringify(upn)}`);
    } else if (/[<>]/.test(upn)) {
      const message = `autonomous.agentUser.userPrincipalName still contains a placeholder (${upn}); use a verified domain of the tenant`;
      if (dryRun) warnings.push(message);
      else problems.push(message);
    }
    if (typeof mailNickname !== "string" || !/^[^\s@()<>,;:\\"[\]]{1,64}$/.test(mailNickname)) {
      problems.push(`autonomous.agentUser.mailNickname must be 1-64 characters without spaces or @()<>,;:\\"[], got ${JSON.stringify(mailNickname)}`);
    }
  }

  const echo = section(raw.echo, "echo");
  unknownKeys(echo, "echo");
  const de = DEFAULTS.echo;
  config.echo = {
    enabled: echo ? flag(echo.enabled, "echo.enabled", false) : false,
    appName: text(echo?.appName, "echo.appName", de.appName),
    scopeValue: permission(echo?.scopeValue, "echo.scopeValue", de.scopeValue),
    appRoleValue: permission(echo?.appRoleValue, "echo.appRoleValue", de.appRoleValue),
  };
  return { config, problems, warnings };
}

/** Sections to run: the --only list, or every enabled section. */
export function selectSections(config, only) {
  if (only?.length) {
    const unknown = only.filter((s) => !SECTIONS.includes(s));
    if (unknown.length) throw new SetupError(`--only: unknown section ${unknown.join(", ")}; use interactive, autonomous or echo`);
    const disabled = only.filter((s) => !config[s].enabled);
    if (disabled.length) {
      throw new SetupError(`--only ${disabled.join(", ")}: disabled in the config`, `Set "enabled": true in the ${disabled.join(" and ")} section.`);
    }
    return SECTIONS.filter((s) => only.includes(s));
  }
  const enabled = SECTIONS.filter((s) => config[s].enabled);
  if (!enabled.length) throw new SetupError("No section is enabled in the config.", 'Set "enabled": true for interactive, autonomous and/or echo.');
  return enabled;
}

/** Delegated Graph permissions for this run, as full scope URIs. */
export function computeScopes(config, sections) {
  const scopes = [...BASE_SCOPES];
  const agentUser = config.autonomous.enabled && config.autonomous.agentUser.enabled;
  if (agentUser && (sections.includes("autonomous") || sections.includes("echo"))) {
    scopes.push("AgentIdUser.ReadWrite.IdentityParentedBy");
    // Looking the agent user up by UPN (GET /users/{upn}) needs a user read permission.
    scopes.push("User.ReadBasic.All");
  }
  if (agentUser && sections.includes("autonomous") && config.autonomous.agentUser.assignDirectoryReaders) scopes.push("RoleManagement.ReadWrite.Directory");
  if (sections.includes("echo")) scopes.push("AppRoleAssignment.ReadWrite.All");
  return scopes.map((scope) => `${GRAPH_RESOURCE}/${scope}`);
}

// ---------------------------------------------------------------- certificates

/** Relative paths: current directory first, then the project root. */
function resolveInputPath(path) {
  if (isAbsolute(path)) return { file: path, tried: [path] };
  const tried = [...new Set([resolve(process.cwd(), path), resolve(PROJECT_ROOT, path)])];
  return { file: tried.find((candidate) => existsSync(candidate)) ?? tried[0], tried };
}

/**
 * Reads a certificate from a .cer (DER, or Base64 DER) or PEM file (first CERTIFICATE block).
 * Only the public certificate is used.
 */
export function readCertificate(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString("latin1");
  let der;
  if (text.includes("-----BEGIN")) {
    const match = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(text);
    if (!match) throw new SetupError(`${displayPath(file)} contains PEM data but no CERTIFICATE block`);
    der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  } else if (bytes[0] === 0x30) {
    der = bytes;
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    der = Buffer.from(text.replace(/\s+/g, ""), "base64");
  } else {
    throw new SetupError(`${displayPath(file)} is neither a DER (.cer) nor a PEM certificate`);
  }
  let x509;
  try {
    x509 = new X509Certificate(der);
  } catch (err) {
    throw new SetupError(`${displayPath(file)} is not a valid X.509 certificate (${err.message})`);
  }
  const commonName = /(?:^|\n)CN=([^\n]*)/.exec(x509.subject)?.[1];
  return {
    file,
    base64: x509.raw.toString("base64"),
    thumbprint: x509.fingerprint.replace(/:/g, "").toUpperCase(),
    displayName: commonName ? `CN=${commonName}` : x509.subject.split("\n").join(", "),
    notBefore: new Date(x509.validFrom),
    notAfter: new Date(x509.validTo),
    keyType: x509.publicKey.asymmetricKeyType,
    containsPrivateKey: /PRIVATE KEY-----/.test(text),
  };
}

/**
 * Normalizes keyCredential.customKeyIdentifier to an upper-case hex thumbprint.
 * Graph may return it as 40 hex characters or as Base64 (of the 20 thumbprint bytes,
 * or of the hex text).
 */
export function keyIdentifierToHex(value) {
  if (typeof value !== "string" || !value) return undefined;
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toUpperCase();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 20) return bytes.toString("hex").toUpperCase();
  const decoded = bytes.toString("latin1");
  return /^[0-9a-f]{40}$/i.test(decoded) ? decoded.toUpperCase() : undefined;
}

/** Checks run-specific settings (certificate files, placeholders) for the selected sections. */
function loadCertificates(config, sections, dryRun, warnings) {
  const problems = [];
  const certificates = {};
  for (const section of ["interactive", "autonomous"]) {
    if (!sections.includes(section)) continue;
    const configured = config[section].certificatePath;
    const { file, tried } = resolveInputPath(configured);
    if (!existsSync(file)) {
      const name = basename(configured, extname(configured)).replace(/\.cert$/, "");
      const message = `${section}.certificatePath: ${configured} not found (looked at ${tried.join(" and ")}). Create it with: node scripts/cert/new-blueprint-cert.mjs --name ${name}`;
      if (!dryRun) {
        problems.push(message);
        continue;
      }
      warnings.push(`${message}. The dry run shows placeholders.`);
      certificates[section] = {
        file,
        placeholder: true,
        base64: `<Base64 of the DER certificate ${configured}>`,
        thumbprint: "<SHA-1 thumbprint>",
        displayName: `CN=<subject of ${configured}>`,
      };
      continue;
    }
    try {
      const cert = readCertificate(file);
      if (cert.notAfter.getTime() < Date.now()) {
        problems.push(`${section}.certificatePath: the certificate expired on ${cert.notAfter.toISOString()}; create a new one`);
      } else if (cert.notAfter.getTime() - Date.now() < 30 * 24 * 3600_000) {
        warnings.push(`${section}: the certificate expires on ${cert.notAfter.toISOString()}; plan its rotation (docs/certificate-auth.md)`);
      }
      if (cert.notBefore.getTime() > Date.now()) warnings.push(`${section}: the certificate is not valid before ${cert.notBefore.toISOString()}`);
      if (cert.keyType !== "rsa") warnings.push(`${section}: the certificate has a ${cert.keyType} key; the sample signs client assertions with RSA`);
      if (cert.containsPrivateKey) {
        warnings.push(`${section}.certificatePath also contains a private key; only the certificate is used, but point it at the public .cer file`);
      }
      certificates[section] = cert;
    } catch (err) {
      problems.push(`${section}.certificatePath: ${err.message}`);
    }
  }
  const { interactive: i, autonomous: a } = certificates;
  if (i && a && !i.placeholder && i.thumbprint === a.thumbprint) {
    warnings.push("interactive and autonomous use the same certificate; give each blueprint its own, so a leaked key exposes one Worker only");
  }
  return { certificates, problems };
}

// ---------------------------------------------------------------- state and output files

function loadStateFile(file) {
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return isPlainObject(data) ? data : {};
  } catch (err) {
    throw new SetupError(`Cannot read the state file ${displayPath(file)}: ${err.message}`, "Fix or delete it; it only caches object ids.");
  }
}

/** Atomic write: temp file in the same directory, then rename. */
function writeJsonFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

function sectionState(ctx, section) {
  ctx.state[section] ??= {};
  return ctx.state[section];
}

/** Records an object (ids only) in the state file. */
function remember(ctx, section, key, value) {
  sectionState(ctx, section)[key] = value;
  ctx.persist();
}

// ---------------------------------------------------------------- Microsoft Graph client

function queryString(query) {
  const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined);
  return entries.length ? `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}` : "";
}

function readableUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** Shortens certificate bodies (public, but long) in dry-run output. */
function forDisplay(body) {
  return JSON.parse(JSON.stringify(body), (key, value) =>
    key === "key" && typeof value === "string" && value.length > 80 && !value.startsWith("<")
      ? `${value.slice(0, 32)}...(${value.length} Base64 characters)`
      : value,
  );
}

function isNotFoundError(status, message) {
  return status === 404 || (status === 400 && NOT_FOUND_PATTERN.test(message ?? ""));
}

function isConflict(err) {
  return err instanceof GraphError && (err.status === 409 || (err.status === 400 && CONFLICT_PATTERN.test(err.message)));
}

function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  let seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    seconds = (at - Date.now()) / 1000;
  }
  return Math.min(120, Math.max(1, Math.ceil(seconds)));
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readGraphError(response) {
  const text = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const error = body?.error ?? {};
  return {
    code: error.code ?? `HTTP${response.status}`,
    message: error.message || text.slice(0, 500) || response.statusText,
    details: Array.isArray(error.details) ? error.details.map((d) => d?.message).filter(Boolean) : [],
    requestId: error.innerError?.["request-id"] ?? response.headers.get("request-id") ?? undefined,
    date: error.innerError?.date ?? response.headers.get("date") ?? undefined,
  };
}

/**
 * Returns graph(request), which sends one Microsoft Graph request with retries.
 *
 * request: { step, method, path, query?, body?, agentId? (adds OData-Version: 4.0),
 *            notFound?: "fail" | "return" (404 -> null) | "retry" (replication delay),
 *            idempotent? (a POST that is safe to repeat), recover? (async lookup that finds
 *            the object a failed POST may have created), hint?, hint400?, dryRunResult? }
 */
function createGraphClient({ accessToken, dryRun, verbose }) {
  return async function graph(request) {
    const url = `${GRAPH}${request.path}${queryString(request.query)}`;
    const shownUrl = readableUrl(url);
    if (dryRun) {
      console.log(`      ${request.method} ${shownUrl}${request.agentId ? "   [OData-Version: 4.0]" : ""}`);
      if (request.body !== undefined) console.log(indent(JSON.stringify(forDisplay(request.body), null, 2), 8));
      if ("dryRunResult" in request) return request.dryRunResult;
      if (request.method !== "GET") return null;
      return request.notFound === "return" ? null : { value: [] };
    }
    if (verbose) console.log(`      ${request.method} ${shownUrl}`);

    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" };
    if (request.agentId) headers["OData-Version"] = "4.0";
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    // A POST that failed with a 5xx or a network error may still have created the object.
    const repeatable = request.method !== "POST" || request.idempotent === true || typeof request.recover === "function";

    for (let attempt = 1; ; attempt++) {
      let response;
      let network;
      try {
        response = await fetch(url, { method: request.method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        network = describeNetworkError(err);
      }
      if (response?.ok) return readJson(response);
      const error = response ? await readGraphError(response) : undefined;
      if (response?.status === 404 && request.notFound === "return") return null;

      const retryable = response
        ? response.status === 429 ||
          (request.notFound === "retry" && isNotFoundError(response.status, error.message)) ||
          (response.status >= 500 && repeatable)
        : network.transient && repeatable;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw response
          ? new GraphError({ step: request.step, method: request.method, url: shownUrl, status: response.status, ...error, hint: request.hint, hint400: request.hint400 })
          : new GraphError({ step: request.step, method: request.method, url: shownUrl, status: 0, code: network.code, message: network.message, hint: network.hint });
      }
      const seconds = (response && retryAfterSeconds(response)) ?? BACKOFF_SECONDS[attempt - 1];
      let reason = network?.code;
      if (response?.status === 429) reason = "HTTP 429, throttled";
      else if (response?.status >= 500) reason = `HTTP ${response.status} ${error.code}, server error`;
      else if (response) reason = `HTTP ${response.status} ${error.code}, a new object is probably still replicating`;
      console.log(`      ... ${reason}; retrying in ${seconds} s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      await sleep(seconds * 1000);
      if ((!response || response.status >= 500) && request.method === "POST" && !request.idempotent && request.recover) {
        const existing = await request.recover().catch(() => undefined);
        if (existing) {
          console.log("      ... the object was created despite the error; using it");
          return existing;
        }
      }
    }
  };
}

/** Repeats a lookup a few times (for objects that may still be replicating). */
async function retryLookup(lookup) {
  for (const seconds of [2, 4, 8]) {
    await sleep(seconds * 1000);
    const found = await lookup();
    if (found) return found;
  }
  return undefined;
}

/** Exactly one match, or a clear error when a name is ambiguous. */
function single(items, step, statePath) {
  const list = items ?? [];
  if (list.length > 1) {
    throw new SetupError(
      `${step}: ${list.length} objects have this name (${list.map((item) => item.id).join(", ")}).`,
      `Delete the ones you do not need, or record the right one in the state file under <tenantId> > ${statePath}.`,
    );
  }
  return list[0];
}

function newId(ctx, placeholder) {
  return ctx.dryRun ? `<${placeholder}>` : randomUUID();
}

// ---------------------------------------------------------------- steps: users, blueprints, identities

async function resolveSponsor(ctx) {
  title(ctx, "Signed-in user (sponsor and owner of the new objects)");
  let me;
  try {
    me = await ctx.graph({
      step: "Read the signed-in user",
      method: "GET",
      path: "/me",
      query: { $select: "id,userPrincipalName" },
      hint: NEEDS.me,
      dryRunResult: { id: "<signedInUser.id>", userPrincipalName: "<signed-in user>" },
    });
  } catch (err) {
    if (!ctx.config.sponsorUserId) throw err;
    warn(ctx, `GET /me failed (${shortError(err)}); using sponsorUserId from the config`);
  }
  ctx.sponsorId = ctx.config.sponsorUserId ?? me.id;
  if (ctx.config.sponsorUserId) report("ok", `sponsor and owner: ${ctx.sponsorId} (sponsorUserId)${me ? `; signed in as ${me.userPrincipalName}` : ""}`);
  else report("ok", `sponsor and owner: ${me.userPrincipalName} (${me.id}), the signed-in user`);
}

const BLUEPRINT_SELECT = "id,appId,displayName,keyCredentials,identifierUris,api";

/** Finds (state file, then name) or creates the agent identity blueprint of a section. */
async function ensureBlueprint(ctx, section, { create = true } = {}) {
  const name = ctx.config[section].blueprintName;
  const step = `${section}: agent identity blueprint '${name}'`;
  title(ctx, step);
  const lookupByName = async () => {
    try {
      const result = await ctx.graph({
        step,
        method: "GET",
        path: "/applications/microsoft.graph.agentIdentityBlueprint",
        query: { $filter: `displayName eq ${odataString(name)}`, $select: BLUEPRINT_SELECT },
        agentId: true,
        hint: NEEDS.blueprint,
      });
      return single(result?.value, step, `${section} > blueprint`);
    } catch (err) {
      if (err instanceof SetupError) throw err;
      warn(ctx, `${step}: lookup by name failed (${shortError(err)}); relying on the state file only`);
      return undefined;
    }
  };

  let blueprint;
  const saved = sectionState(ctx, section).blueprint;
  if (saved?.id && saved.displayName === name) {
    blueprint = await ctx.graph({
      step,
      method: "GET",
      path: `/applications/${saved.id}`,
      query: { $select: BLUEPRINT_SELECT },
      agentId: true,
      notFound: "return",
      hint: NEEDS.blueprint,
    });
    if (!blueprint) report("info", `blueprint ${saved.id} from the state file no longer exists; looking it up by name`);
  }
  blueprint ??= await lookupByName();
  if (blueprint) {
    report("exists", `blueprint '${name}' (appId ${blueprint.appId}, object id ${blueprint.id})`);
  } else if (!create) {
    return undefined;
  } else {
    blueprint = await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: "/applications/microsoft.graph.agentIdentityBlueprint",
      agentId: true,
      body: {
        displayName: name,
        "sponsors@odata.bind": [userRef(ctx.sponsorId)],
        "owners@odata.bind": [userRef(ctx.sponsorId)],
      },
      recover: lookupByName,
      hint: NEEDS.blueprint,
      dryRunResult: {
        id: `<${section}.blueprint.id>`,
        appId: `<${section}.blueprint.appId>`,
        displayName: name,
        keyCredentials: [],
        identifierUris: [],
        api: { oauth2PermissionScopes: [] },
      },
    });
    report("created", `blueprint '${name}' (appId ${blueprint.appId}, object id ${blueprint.id})`);
  }
  remember(ctx, section, "blueprint", { id: blueprint.id, appId: blueprint.appId, displayName: name });
  return blueprint;
}

/** Finds a service principal by appId, or creates it (POST to createPath with {appId}). */
async function ensureServicePrincipal(ctx, { step, label, appId, select = "id,appId,displayName", createPath = "/servicePrincipals", agentId = false, placeholder, hint }) {
  title(ctx, step);
  const lookup = async () => {
    const result = await ctx.graph({ step, method: "GET", path: "/servicePrincipals", query: { $filter: `appId eq '${appId}'`, $select: select }, agentId, hint });
    return result?.value?.[0];
  };
  let servicePrincipal = await lookup();
  if (servicePrincipal) {
    report("exists", `${label} (id ${servicePrincipal.id})`);
    return servicePrincipal;
  }
  try {
    servicePrincipal = await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: createPath,
      body: { appId },
      agentId,
      notFound: "retry",
      idempotent: true,
      hint,
      dryRunResult: { id: placeholder, appId },
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
    servicePrincipal = await retryLookup(lookup);
    if (!servicePrincipal) throw err;
    report("exists", `${label} (id ${servicePrincipal.id})`);
    return servicePrincipal;
  }
  report("created", `${label} (id ${servicePrincipal.id})`);
  return servicePrincipal;
}

async function ensureBlueprintPrincipal(ctx, section, blueprint) {
  const principal = await ensureServicePrincipal(ctx, {
    step: `${section}: blueprint principal`,
    label: "blueprint principal",
    appId: blueprint.appId,
    select: "id,appId",
    createPath: "/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal",
    agentId: true,
    placeholder: `<${section}.blueprintPrincipal.id>`,
    hint: NEEDS.blueprintPrincipal,
  });
  remember(ctx, section, "blueprintPrincipal", { id: principal.id });
  return principal;
}

/** Exposes api://<appId>/<scopeValue> on the interactive blueprint (users get tokens with aud = blueprint). */
async function ensureBlueprintScope(ctx, blueprint) {
  const value = ctx.config.interactive.scopeValue;
  const uri = `api://${blueprint.appId}`;
  const step = `interactive: expose ${uri}/${value} on the blueprint`;
  title(ctx, step);
  const api = blueprint.api ?? {};
  // Existing scopes are kept as they are: Entra refuses to change or remove an enabled scope.
  const scopes = (api.oauth2PermissionScopes ?? []).map(cleanPermissionScope);
  const changes = [];
  let scope = scopes.find((s) => s.value === value);
  if (!scope) {
    scope = {
      adminConsentDescription: "Allow the application to access the agent on behalf of the signed-in user.",
      adminConsentDisplayName: "Access agent",
      id: newId(ctx, "interactive.scope.id"),
      isEnabled: true,
      type: "User",
      value,
    };
    scopes.push(scope);
    changes.push(`added scope '${value}'`);
  } else if (!scope.isEnabled) {
    scope.isEnabled = true;
    changes.push(`enabled scope '${value}'`);
  }
  const identifierUris = [...(blueprint.identifierUris ?? [])];
  if (!identifierUris.includes(uri)) {
    identifierUris.push(uri);
    changes.push("identifier URI");
  }
  if (api.requestedAccessTokenVersion !== 2) changes.push("v2.0 access tokens");
  if (!changes.length) {
    report("exists", `exposed API ${uri}/${value} (scope id ${scope.id})`);
    return scope;
  }
  await ctx.graph({
    step,
    method: "PATCH",
    path: `/applications/${blueprint.id}`,
    agentId: true,
    notFound: "retry",
    hint: NEEDS.blueprintAuth,
    body: { identifierUris, api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: scopes } },
  });
  blueprint.identifierUris = identifierUris;
  blueprint.api = { ...api, requestedAccessTokenVersion: 2, oauth2PermissionScopes: scopes };
  report("updated", `exposed API ${uri}/${value} (${changes.join(", ")})`);
  return scope;
}

/** Finds (state file, then name within this blueprint) or creates the agent identity. */
async function ensureAgentIdentity(ctx, section, blueprint, { create = true } = {}) {
  const name = ctx.config[section].agentIdentityName;
  const step = `${section}: agent identity '${name}'`;
  title(ctx, step);
  const lookupByName = async () => {
    try {
      const result = await ctx.graph({
        step,
        method: "GET",
        path: "/servicePrincipals/microsoft.graph.agentIdentity",
        query: { $filter: `displayName eq ${odataString(name)}`, $select: "id,appId,displayName,agentIdentityBlueprintId" },
        agentId: true,
        hint: NEEDS.agentIdentity,
      });
      const ofThisBlueprint = (result?.value ?? []).filter((item) => sameId(item.agentIdentityBlueprintId, blueprint.appId));
      return single(ofThisBlueprint, step, `${section} > agentIdentity`);
    } catch (err) {
      if (err instanceof SetupError) throw err;
      warn(ctx, `${step}: lookup by name failed (${shortError(err)}); relying on the state file only`);
      return undefined;
    }
  };

  let identity;
  const saved = sectionState(ctx, section).agentIdentity;
  if (saved?.id && saved.displayName === name && sameId(saved.blueprintAppId, blueprint.appId)) {
    identity = await ctx.graph({
      step,
      method: "GET",
      path: `/servicePrincipals/${saved.id}`,
      query: { $select: "id,appId,displayName" },
      agentId: true,
      notFound: "return",
      hint: NEEDS.agentIdentity,
    });
    if (!identity) report("info", `agent identity ${saved.id} from the state file no longer exists; looking it up by name`);
  }
  identity ??= await lookupByName();
  if (identity) {
    report("exists", `agent identity '${name}' (id ${identity.id})`);
  } else if (!create) {
    return undefined;
  } else {
    identity = await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: "/servicePrincipals/microsoft.graph.agentIdentity",
      agentId: true,
      body: { displayName: name, agentIdentityBlueprintId: blueprint.appId, "sponsors@odata.bind": [userRef(ctx.sponsorId)] },
      notFound: "retry",
      recover: lookupByName,
      hint: NEEDS.agentIdentity,
      dryRunResult: { id: `<${section}.agentIdentity.id>`, appId: `<${section}.agentIdentity.id>`, displayName: name },
    });
    report("created", `agent identity '${name}' (id ${identity.id})`);
  }
  remember(ctx, section, "agentIdentity", { id: identity.id, displayName: name, blueprintAppId: blueprint.appId });
  return identity;
}

/** Agent user of the autonomous agent identity (Frontier preview). */
async function ensureAgentUser(ctx, identity, { create = true } = {}) {
  const settings = ctx.config.autonomous.agentUser;
  const upn = settings.userPrincipalName;
  const step = `autonomous: agent user '${upn}'`;
  title(ctx, step);
  const lookup = () =>
    ctx.graph({
      step,
      method: "GET",
      path: `/users/${encodeURIComponent(upn)}`,
      query: { $select: "id,userPrincipalName" },
      agentId: true,
      notFound: "return",
      hint: NEEDS.agentUser,
    });

  let user = await lookup();
  let created = false;
  if (!user) {
    if (!create) return undefined;
    try {
      user = await ctx.graph({
        step: `${step}: create`,
        method: "POST",
        path: "/users/microsoft.graph.agentUser",
        agentId: true,
        body: {
          accountEnabled: true,
          displayName: settings.displayName,
          mailNickname: settings.mailNickname,
          userPrincipalName: upn,
          identityParentId: identity.id,
        },
        notFound: "retry",
        idempotent: true,
        hint: NEEDS.agentUser,
        hint400: NEEDS.agentUser,
        dryRunResult: { id: "<autonomous.agentUser.id>", userPrincipalName: upn },
      });
      created = true;
    } catch (err) {
      if (!isConflict(err)) throw err;
      user = await retryLookup(lookup);
      if (!user) throw err;
    }
  }
  if (created) {
    report("created", `agent user ${upn} (id ${user.id}) for agent identity ${identity.id}`);
  } else {
    await verifyAgentUserParent(ctx, user, identity, step);
    report("exists", `agent user ${user.userPrincipalName} (id ${user.id})`);
  }
  remember(ctx, "autonomous", "agentUser", { id: user.id, userPrincipalName: user.userPrincipalName ?? upn });
  return user;
}

/** Best effort: an existing UPN must belong to an agent user of THIS agent identity. */
async function verifyAgentUserParent(ctx, user, identity, step) {
  if (ctx.dryRun || !identity) return;
  let agentUser;
  try {
    agentUser = await ctx.graph({
      step,
      method: "GET",
      path: `/users/${user.id}/microsoft.graph.agentUser`,
      query: { $select: "id,userPrincipalName,identityParentId" },
      agentId: true,
      notFound: "return",
    });
  } catch (err) {
    warn(ctx, `${step}: could not confirm that it is the agent user of agent identity ${identity.id} (${shortError(err)})`);
    return;
  }
  if (!agentUser?.identityParentId) {
    warn(ctx, `${step}: could not read it as an agent user; make sure it is the agent user of agent identity ${identity.id}`);
  } else if (!sameId(agentUser.identityParentId, identity.id)) {
    throw new SetupError(
      `${step}: this user belongs to another agent identity (identityParentId ${agentUser.identityParentId}).`,
      "Choose another autonomous.agentUser.userPrincipalName; each agent identity has its own agent user.",
    );
  }
}

// ---------------------------------------------------------------- steps: grants and roles

/**
 * Ensures an oauth2PermissionGrant (admin consent) exists and contains all scopes.
 * Agent identities cannot be consented to interactively (AADSTS82014), hence these grants.
 */
async function ensureGrant(ctx, { step, label, clientId, resourceId, consentType, principalId, scopes }) {
  title(ctx, step);
  const wanted = [...new Set(scopes)];
  const find = async () => {
    const result = await ctx.graph({
      step,
      method: "GET",
      path: "/oauth2PermissionGrants",
      query: { $filter: `clientId eq '${clientId}' and resourceId eq '${resourceId}'` },
      hint: NEEDS.grant,
    });
    return (result?.value ?? []).find(
      (grant) => grant.consentType === consentType && (consentType === "AllPrincipals" || sameId(grant.principalId, principalId)),
    );
  };

  let grant = await find();
  if (!grant) {
    const body = { clientId, consentType, ...(consentType === "Principal" ? { principalId } : {}), resourceId, scope: wanted.join(" ") };
    try {
      await ctx.graph({
        step: `${step}: create`,
        method: "POST",
        path: "/oauth2PermissionGrants",
        body,
        notFound: "retry",
        idempotent: true,
        hint: NEEDS.grant,
        dryRunResult: { id: "<grant.id>", ...body },
      });
      report("created", `${label}: ${wanted.join(" ")}`);
      return;
    } catch (err) {
      if (!isConflict(err)) throw err;
      grant = await retryLookup(find);
      if (!grant) throw err;
    }
  }
  const granted = splitScopes(grant.scope);
  const missing = wanted.filter((scope) => !granted.some((g) => g.toLowerCase() === scope.toLowerCase()));
  if (!missing.length) {
    report("exists", `${label}: ${granted.join(" ")}`);
    return;
  }
  await ctx.graph({
    step: `${step}: add scopes`,
    method: "PATCH",
    path: `/oauth2PermissionGrants/${grant.id}`,
    body: { scope: [...granted, ...missing].join(" ") },
    notFound: "retry",
    hint: NEEDS.grant,
  });
  report("updated", `${label}: added ${missing.join(" ")}`);
}

/** Optional: Directory Readers for the agent user. Failures are warnings. */
async function ensureDirectoryReaders(ctx, agentUser) {
  const step = "autonomous: Directory Readers role for the agent user (optional)";
  title(ctx, step);
  try {
    const existing = await ctx.graph({
      step,
      method: "GET",
      path: "/roleManagement/directory/roleAssignments",
      query: { $filter: `principalId eq '${agentUser.id}' and roleDefinitionId eq '${DIRECTORY_READERS_ROLE_ID}'` },
      hint: NEEDS.directoryRole,
    });
    if (existing?.value?.length) {
      report("exists", "Directory Readers role assignment for the agent user");
      return;
    }
    await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: "/roleManagement/directory/roleAssignments",
      body: { principalId: agentUser.id, roleDefinitionId: DIRECTORY_READERS_ROLE_ID, directoryScopeId: "/" },
      notFound: "retry",
      idempotent: true,
      hint: NEEDS.directoryRole,
      dryRunResult: { id: "<roleAssignment.id>" },
    });
    report("created", "Directory Readers role assignment for the agent user");
  } catch (err) {
    if (isConflict(err)) {
      report("exists", "Directory Readers role assignment for the agent user");
      return;
    }
    warn(
      ctx,
      `${step} failed (${shortError(err)}). Continuing without it: agent users have guest-like default permissions, so directory reads may be limited. ${NEEDS.directoryRole}`,
    );
  }
}

/** App role assignment (app-only permission) for an agent identity. */
async function ensureAppRoleAssignment(ctx, { step, label, identity, resource, role }) {
  title(ctx, step);
  const path = `/servicePrincipals/${identity.id}/appRoleAssignments`;
  const existing = await ctx.graph({ step, method: "GET", path, agentId: true, notFound: "retry", hint: NEEDS.appRole });
  if ((existing?.value ?? []).some((a) => sameId(a.resourceId, resource.id) && sameId(a.appRoleId, role.id))) {
    report("exists", label);
    return;
  }
  try {
    await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path,
      agentId: true,
      body: { principalId: identity.id, resourceId: resource.id, appRoleId: role.id },
      notFound: "retry",
      idempotent: true,
      hint: NEEDS.appRole,
      dryRunResult: { id: "<appRoleAssignment.id>" },
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
    report("exists", label);
    return;
  }
  report("created", label);
}

// ---------------------------------------------------------------- steps: app registrations

/** State file entry first (if the name still matches), then a lookup by displayName. */
async function findApplication(ctx, { step, section, key, name, select }) {
  const saved = sectionState(ctx, section)[key];
  if (saved?.id && saved.displayName === name) {
    const app = await ctx.graph({ step, method: "GET", path: `/applications/${saved.id}`, query: { $select: select }, notFound: "return", hint: NEEDS.app });
    if (app) return app;
    report("info", `app ${saved.id} from the state file no longer exists; looking it up by name`);
  }
  return lookupApplicationByName(ctx, { step, section, key, name, select });
}

async function lookupApplicationByName(ctx, { step, section, key, name, select }) {
  const result = await ctx.graph({
    step,
    method: "GET",
    path: "/applications",
    query: { $filter: `displayName eq ${odataString(name)}`, $select: select },
    hint: NEEDS.app,
  });
  return single(result?.value, step, `${section} > ${key}`);
}

/** Public client app registration that the CLI (scripts/client/agent-cli.mjs) signs users in with. */
async function ensureClientApp(ctx, blueprint, scope) {
  const name = ctx.config.interactive.clientAppName;
  const step = `interactive: CLI client app '${name}'`;
  title(ctx, step);
  const select = "id,appId,displayName,isFallbackPublicClient,publicClient,requiredResourceAccess";
  const lookupArgs = { step, section: "interactive", key: "clientApp", name, select };
  const access = { resourceAppId: blueprint.appId, resourceAccess: [{ id: scope.id, type: "Scope" }] };

  let app = await findApplication(ctx, lookupArgs);
  if (!app) {
    app = await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: "/applications",
      body: {
        displayName: name,
        signInAudience: "AzureADMyOrg",
        isFallbackPublicClient: true,
        publicClient: { redirectUris: ["http://localhost"] },
        requiredResourceAccess: [access],
      },
      recover: () => lookupApplicationByName(ctx, lookupArgs),
      hint: NEEDS.app,
      dryRunResult: { id: "<interactive.clientApp.id>", appId: "<interactive.clientApp.appId>", displayName: name },
    });
    report("created", `CLI client app '${name}' (appId ${app.appId})`);
  } else {
    // Converge an existing registration: add what the sample needs, keep everything else.
    const patch = {};
    const redirectUris = app.publicClient?.redirectUris ?? [];
    if (!redirectUris.includes("http://localhost")) patch.publicClient = { redirectUris: [...redirectUris, "http://localhost"] };
    if (app.isFallbackPublicClient !== true) patch.isFallbackPublicClient = true;
    const required = (app.requiredResourceAccess ?? []).map((entry) => ({ ...entry, resourceAccess: [...(entry.resourceAccess ?? [])] }));
    const entry = required.find((e) => sameId(e.resourceAppId, blueprint.appId));
    if (!entry) {
      required.push(access);
      patch.requiredResourceAccess = required;
    } else if (!entry.resourceAccess.some((a) => sameId(a.id, scope.id))) {
      entry.resourceAccess.push({ id: scope.id, type: "Scope" });
      patch.requiredResourceAccess = required;
    }
    if (Object.keys(patch).length) {
      await ctx.graph({ step: `${step}: update`, method: "PATCH", path: `/applications/${app.id}`, body: patch, notFound: "retry", hint: NEEDS.app });
      report("updated", `CLI client app '${name}' (appId ${app.appId}): ${Object.keys(patch).join(", ")}`);
    } else {
      report("exists", `CLI client app '${name}' (appId ${app.appId})`);
    }
  }
  remember(ctx, "interactive", "clientApp", { id: app.id, appId: app.appId, displayName: name });
  return app;
}

/** The optional echo MCP server: delegated scope + app role, identifier URI api://<appId>. */
async function ensureEchoApp(ctx) {
  const settings = ctx.config.echo;
  const name = settings.appName;
  const step = `echo: app registration '${name}'`;
  title(ctx, step);
  const lookupArgs = { step, section: "echo", key: "app", name, select: "id,appId,displayName,identifierUris,api,appRoles,optionalClaims" };
  const newScope = () => ({
    id: newId(ctx, "echo.scope.id"),
    value: settings.scopeValue,
    type: "User",
    isEnabled: true,
    adminConsentDisplayName: "Call the echo MCP server",
    adminConsentDescription: "Allows the app to call the echo MCP server on behalf of the signed-in user.",
  });
  const newRole = () => ({
    id: newId(ctx, "echo.appRole.id"),
    value: settings.appRoleValue,
    allowedMemberTypes: ["Application"],
    displayName: "Call the echo MCP server as an application",
    description: "Allows an application or agent to call the echo MCP server with its own identity.",
    isEnabled: true,
  });

  let app = await findApplication(ctx, lookupArgs);
  if (!app) {
    const body = {
      displayName: name,
      signInAudience: "AzureADMyOrg",
      api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [newScope()] },
      appRoles: [newRole()],
    };
    app = await ctx.graph({
      step: `${step}: create`,
      method: "POST",
      path: "/applications",
      body,
      recover: () => lookupApplicationByName(ctx, lookupArgs),
      hint: NEEDS.app,
      dryRunResult: { id: "<echo.app.id>", appId: "<echo.app.appId>", identifierUris: [], ...body },
    });
    report("created", `echo MCP app '${name}' (appId ${app.appId})`);
  } else {
    const scopes = (app.api?.oauth2PermissionScopes ?? []).map(cleanPermissionScope);
    const roles = (app.appRoles ?? []).map(cleanAppRole);
    const changes = [];
    const existingScope = scopes.find((s) => s.value === settings.scopeValue);
    if (!existingScope) {
      scopes.push(newScope());
      changes.push(`scope '${settings.scopeValue}'`);
    } else if (!existingScope.isEnabled) {
      existingScope.isEnabled = true;
      changes.push(`enabled scope '${settings.scopeValue}'`);
    }
    const existingRole = roles.find((r) => r.value === settings.appRoleValue);
    if (!existingRole) {
      roles.push(newRole());
      changes.push(`app role '${settings.appRoleValue}'`);
    } else if (!existingRole.isEnabled) {
      existingRole.isEnabled = true;
      changes.push(`enabled app role '${settings.appRoleValue}'`);
    }
    if (app.api?.requestedAccessTokenVersion !== 2) changes.push("v2.0 access tokens");
    if (changes.length) {
      const patch = { api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: scopes }, appRoles: roles };
      await ctx.graph({ step: `${step}: update`, method: "PATCH", path: `/applications/${app.id}`, body: patch, notFound: "retry", hint: NEEDS.app });
      app.api = { ...app.api, ...patch.api };
      app.appRoles = roles;
      report("updated", `echo MCP app '${name}' (appId ${app.appId}): ${changes.join(", ")}`);
    } else {
      report("exists", `echo MCP app '${name}' (appId ${app.appId})`);
    }
  }
  const scope = (app.api?.oauth2PermissionScopes ?? []).find((s) => s.value === settings.scopeValue);
  const role = (app.appRoles ?? []).find((r) => r.value === settings.appRoleValue);
  if (role && !role.allowedMemberTypes?.includes("Application")) {
    warn(ctx, `${step}: app role '${role.value}' does not allow applications, so it cannot be assigned to an agent identity`);
  }

  // The identifier URI contains the appId, so it can only be set after the create.
  const uri = `api://${app.appId}`;
  if (!(app.identifierUris ?? []).includes(uri)) {
    const identifierUris = [...(app.identifierUris ?? []), uri];
    await ctx.graph({ step: `${step}: identifier URI`, method: "PATCH", path: `/applications/${app.id}`, body: { identifierUris }, notFound: "retry", hint: NEEDS.app });
    app.identifierUris = identifierUris;
    report("updated", `echo MCP app identifier URI ${uri}`);
  }
  await ensureAgentClaims(ctx, app, step);
  remember(ctx, "echo", "app", { id: app.id, appId: app.appId, displayName: name });
  return { app, scope, role };
}

/**
 * The Agent ID claims (xms_par_app_azp, xms_act_fct, xms_sub_fct, xms_tnt_fct) are optional
 * claims of the RESOURCE: Entra only puts them in access tokens for an API whose app
 * registration asks for them. Without them the echo MCP server cannot tell an agent from any
 * other app and answers 403 access_denied. Existing optional claims are kept.
 */
async function ensureAgentClaims(ctx, app, step) {
  const { optionalClaims, added } = mergeAgentClaims(app.optionalClaims);
  if (!added.length) {
    report("exists", "echo MCP app Agent ID optional claims");
    return;
  }
  const names = AGENT_ACCESS_TOKEN_CLAIMS.map((c) => c.name).join(", ");
  await ctx.graph({
    step: `${step}: Agent ID optional claims`,
    method: "PATCH",
    path: `/applications/${app.id}`,
    body: { optionalClaims },
    notFound: "retry",
    hint: NEEDS.app,
    hint400: `Add the access token optional claims ${names} by hand: Microsoft Entra admin center > App registrations > ${app.displayName ?? "the echo MCP app"} > Manifest (optionalClaims.accessToken). See docs/entra-setup-guide.md.`,
  });
  app.optionalClaims = optionalClaims;
  report("updated", `echo MCP app optional claims for agent tokens: ${added.join(", ")}`);
}

// ---------------------------------------------------------------- steps: certificate

/**
 * Registers the section's certificate on its blueprint.
 * A PATCH replaces the whole keyCredentials collection and Graph never returns existing
 * `key` values, so the script only PATCHes a blueprint that has no certificate yet.
 */
async function ensureBlueprintCertificate(ctx, section, blueprint) {
  const cert = ctx.certificates[section];
  const name = ctx.config[section].blueprintName;
  const step = `${section}: certificate on blueprint '${name}'`;
  title(ctx, step);
  let credentials = blueprint.keyCredentials;
  if (!Array.isArray(credentials)) {
    const fresh = await ctx.graph({
      step,
      method: "GET",
      path: `/applications/${blueprint.id}`,
      query: { $select: "id,keyCredentials" },
      agentId: true,
      notFound: "retry",
      hint: NEEDS.certificate,
    });
    credentials = fresh?.keyCredentials;
  }
  const where = `the Microsoft Entra admin center (Agent ID > Agent blueprints > ${name} > Certificates & secrets) or with the addKey API; see docs/certificate-auth.md (Rotation without downtime)`;
  if (!Array.isArray(credentials)) {
    requireAction(ctx, `${step}: could not read the blueprint's certificates, so none was added. Add ${displayPath(cert.file)} in ${where}.`);
    return;
  }
  if (credentials.some((c) => keyIdentifierToHex(c.customKeyIdentifier) === cert.thumbprint)) {
    report("exists", `certificate ${cert.thumbprint} (${cert.displayName}) on blueprint '${name}'`);
    return;
  }
  if (credentials.length) {
    const others = credentials.map((c) => c.displayName ?? c.keyId).join(", ");
    requireAction(
      ctx,
      `${step}: the blueprint already has other certificates (${others}). The script does not replace them (a PATCH would remove them). Add ${displayPath(cert.file)} (thumbprint ${cert.thumbprint}) in ${where}.`,
    );
    return;
  }
  await ctx.graph({
    step,
    method: "PATCH",
    path: `/applications/${blueprint.id}/microsoft.graph.agentIdentityBlueprint`,
    agentId: true,
    body: { keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: cert.base64, displayName: cert.displayName }] },
    notFound: "retry",
    hint: NEEDS.certificate,
  });
  blueprint.keyCredentials = [{ customKeyIdentifier: cert.thumbprint, displayName: cert.displayName }];
  const expires = cert.notAfter ? `, expires ${cert.notAfter.toISOString().slice(0, 10)}` : "";
  report("created", `certificate ${cert.thumbprint} (${cert.displayName}${expires}) on blueprint '${name}'`);
}

// ---------------------------------------------------------------- sections

/** MCP Server for Enterprise service principal, created once per tenant if missing. */
async function ensureMcpServer(ctx) {
  if (ctx.mcpServer !== undefined) return ctx.mcpServer;
  const { appId, delegatedScopes } = ctx.config.mcpServer;
  if (!delegatedScopes.length) {
    report("skip", "mcpServer.delegatedScopes is empty: no grants to MCP Server for Enterprise");
    ctx.mcpServer = null;
    return null;
  }
  ctx.mcpServer = await ensureServicePrincipal(ctx, {
    step: "MCP Server for Enterprise service principal",
    label: "MCP Server for Enterprise service principal",
    appId,
    placeholder: "<mcpServer.servicePrincipal.id>",
    hint: NEEDS.app,
  });
  ctx.state.mcpServer = { appId, servicePrincipalId: ctx.mcpServer.id };
  ctx.persist();
  return ctx.mcpServer;
}

async function runInteractive(ctx) {
  console.log("\n== interactive ==");
  const settings = ctx.config.interactive;
  const result = (ctx.results.interactive = {});
  result.blueprint = await ensureBlueprint(ctx, "interactive");
  result.blueprintPrincipal = await ensureBlueprintPrincipal(ctx, "interactive", result.blueprint);
  result.scope = await ensureBlueprintScope(ctx, result.blueprint);
  result.agentIdentity = await ensureAgentIdentity(ctx, "interactive", result.blueprint);

  const mcp = await ensureMcpServer(ctx);
  if (mcp) {
    await ensureGrant(ctx, {
      step: "interactive: admin grant to MCP Server for Enterprise (OBO)",
      label: "grant interactive agent identity -> MCP Server for Enterprise (all users)",
      clientId: result.agentIdentity.id,
      resourceId: mcp.id,
      consentType: "AllPrincipals",
      scopes: ctx.config.mcpServer.delegatedScopes,
    });
  }

  result.clientApp = await ensureClientApp(ctx, result.blueprint, result.scope);
  result.clientServicePrincipal = await ensureServicePrincipal(ctx, {
    step: "interactive: CLI client service principal",
    label: "CLI client service principal",
    appId: result.clientApp.appId,
    placeholder: "<interactive.clientServicePrincipal.id>",
    hint: NEEDS.app,
  });
  remember(ctx, "interactive", "clientServicePrincipal", { id: result.clientServicePrincipal.id });
  await ensureGrant(ctx, {
    step: `interactive: admin grant for the CLI client to call the agent (${settings.scopeValue})`,
    label: "grant CLI client -> interactive blueprint (all users)",
    clientId: result.clientServicePrincipal.id,
    resourceId: result.blueprintPrincipal.id,
    consentType: "AllPrincipals",
    scopes: [settings.scopeValue],
  });

  await ensureBlueprintCertificate(ctx, "interactive", result.blueprint);
}

async function runAutonomous(ctx) {
  console.log("\n== autonomous ==");
  const settings = ctx.config.autonomous;
  const result = (ctx.results.autonomous = {});
  result.blueprint = await ensureBlueprint(ctx, "autonomous");
  result.blueprintPrincipal = await ensureBlueprintPrincipal(ctx, "autonomous", result.blueprint);
  result.agentIdentity = await ensureAgentIdentity(ctx, "autonomous", result.blueprint);

  if (settings.agentUser.enabled) {
    result.agentUser = await ensureAgentUser(ctx, result.agentIdentity);
    const mcp = await ensureMcpServer(ctx);
    if (mcp) {
      await ensureGrant(ctx, {
        step: "autonomous: grant to MCP Server for Enterprise for the agent user",
        label: "grant autonomous agent identity -> MCP Server for Enterprise (agent user only)",
        clientId: result.agentIdentity.id,
        resourceId: mcp.id,
        consentType: "Principal",
        principalId: result.agentUser.id,
        scopes: ctx.config.mcpServer.delegatedScopes,
      });
    }
    if (settings.agentUser.assignDirectoryReaders) await ensureDirectoryReaders(ctx, result.agentUser);
  } else {
    report("skip", "agent user disabled (autonomous.agentUser.enabled = false): the autonomous agent runs app-only");
  }

  await ensureBlueprintCertificate(ctx, "autonomous", result.blueprint);
}

/** Agent identity from this run, or found (not created) when the section did not run now. */
async function resolveAgentIdentity(ctx, section) {
  if (ctx.results[section]?.agentIdentity) return ctx.results[section].agentIdentity;
  if (!ctx.config[section].enabled) return undefined;
  if (ctx.dryRun) return { id: `<${section}.agentIdentity.id>` };
  const blueprint = await ensureBlueprint(ctx, section, { create: false });
  return blueprint ? ensureAgentIdentity(ctx, section, blueprint, { create: false }) : undefined;
}

async function resolveAgentUser(ctx, identity) {
  if (ctx.results.autonomous?.agentUser) return ctx.results.autonomous.agentUser;
  const { enabled, agentUser } = ctx.config.autonomous;
  if (!enabled || !agentUser.enabled) return undefined;
  if (ctx.dryRun) return { id: "<autonomous.agentUser.id>", userPrincipalName: agentUser.userPrincipalName };
  return ensureAgentUser(ctx, identity, { create: false });
}

async function runEcho(ctx) {
  console.log("\n== echo ==");
  const result = (ctx.results.echo = {});
  Object.assign(result, await ensureEchoApp(ctx));
  result.servicePrincipal = await ensureServicePrincipal(ctx, {
    step: "echo: service principal",
    label: "echo MCP service principal",
    appId: result.app.appId,
    placeholder: "<echo.servicePrincipal.id>",
    hint: NEEDS.app,
  });
  remember(ctx, "echo", "servicePrincipal", { id: result.servicePrincipal.id });

  const interactiveAgent = await resolveAgentIdentity(ctx, "interactive");
  if (interactiveAgent) {
    await ensureGrant(ctx, {
      step: "echo: admin grant for the interactive agent identity",
      label: "grant interactive agent identity -> echo MCP (all users)",
      clientId: interactiveAgent.id,
      resourceId: result.servicePrincipal.id,
      consentType: "AllPrincipals",
      scopes: [ctx.config.echo.scopeValue],
    });
  } else {
    report("skip", "no interactive agent identity found (run the interactive section first): delegated echo grant skipped");
  }

  const autonomousAgent = await resolveAgentIdentity(ctx, "autonomous");
  if (!autonomousAgent) {
    report("skip", "no autonomous agent identity found (run the autonomous section first): echo app role and agent user grant skipped");
    return;
  }
  if (result.role) {
    await ensureAppRoleAssignment(ctx, {
      step: `echo: app role '${result.role.value}' for the autonomous agent identity`,
      label: `app role assignment autonomous agent identity -> echo MCP '${result.role.value}'`,
      identity: autonomousAgent,
      resource: result.servicePrincipal,
      role: result.role,
    });
  }
  const agentUser = await resolveAgentUser(ctx, autonomousAgent);
  if (agentUser) {
    await ensureGrant(ctx, {
      step: "echo: grant for the agent user",
      label: "grant autonomous agent identity -> echo MCP (agent user only)",
      clientId: autonomousAgent.id,
      resourceId: result.servicePrincipal.id,
      consentType: "Principal",
      principalId: agentUser.id,
      scopes: [ctx.config.echo.scopeValue],
    });
  }
}

const RUNNERS = { interactive: runInteractive, autonomous: runAutonomous, echo: runEcho };

// ---------------------------------------------------------------- sign-in, intro and summary

function printIntro(ctx, scopes, configFile) {
  const { config, sections } = ctx;
  console.log("Microsoft Entra setup for the agentid-cloudflare sample");
  console.log(`  Config:    ${displayPath(configFile)}`);
  console.log(`  Tenant:    ${config.tenantId}`);
  console.log(`  Sections:  ${sections.join(", ")}`);
  if (ctx.dryRun) {
    console.log("  Mode:      DRY RUN: no sign-in, no network, no files written. Lookups are assumed to find");
    console.log("             nothing, so every object is created; ids in <angle brackets> are placeholders.");
  } else {
    console.log(`  State:     ${displayPath(ctx.stateFile)}`);
  }

  const agentUser = config.autonomous.enabled && config.autonomous.agentUser.enabled;
  const privileged = sections.includes("echo") || (sections.includes("autonomous") && agentUser && config.autonomous.agentUser.assignDirectoryReaders);
  console.log("\nDirectory roles the signed-in user needs:");
  console.log("  - Agent ID Administrator: certificates on blueprints, agent identities, agent users");
  console.log("  - Cloud Application Administrator or Application Administrator: app registrations, delegated permission grants");
  console.log(
    `  - Privileged Role Administrator: the optional Directory Readers assignment and consenting app role assignments (${privileged ? "needed for this run" : "not needed for this run"})`,
  );
  console.log("  A Global Administrator in a test tenant covers all of them.");

  const client = config.graphClientId === GRAPH_CLI_TOOLS_CLIENT_ID ? `${config.graphClientId}, Microsoft Graph Command Line Tools` : config.graphClientId;
  console.log(`\nDelegated Microsoft Graph permissions requested (client ${client}):`);
  for (const scope of scopes) console.log(`  ${scope}`);

  if (agentUser && (sections.includes("autonomous") || sections.includes("echo"))) {
    console.log("\nNote: agent users are currently available only to tenants in the Frontier preview program;");
    console.log("      an agent identity can have one agent user.");
  }
  if (ctx.warnings.length) {
    console.log("");
    for (const text of ctx.warnings) report("warn", text);
  }
}

async function signIn(ctx, scopes, deviceCode) {
  console.log("");
  if (!process.env.ENTRA_ACCESS_TOKEN?.trim()) {
    console.log(`Signing in to tenant ${ctx.config.tenantId}${deviceCode ? " (device code)" : " (browser; use --device-code on a machine without a browser)"}...`);
  }
  const token = await acquireToken({
    tenantId: ctx.config.tenantId,
    clientId: ctx.config.graphClientId,
    scopes,
    mode: deviceCode ? "device" : "browser",
    allowEnvToken: true,
    log: (message) => console.log(indent(message, 2)),
  });
  confirmToken(ctx, token, scopes);
  return token.accessToken;
}

/** Prints the token's non-secret claims and checks tenant, audience and permissions. */
function confirmToken(ctx, token, scopes) {
  const claims = publicClaims(token.claims);
  if (!claims) {
    warn(ctx, "The access token is not a readable JWT, so its tenant and permissions were not checked.");
    return;
  }
  if (claims.tid && !sameId(claims.tid, ctx.config.tenantId)) {
    throw new SetupError(`The token is for tenant ${claims.tid}, but the config's tenantId is ${ctx.config.tenantId}.`, "Sign in with an account of the configured tenant, or fix tenantId.");
  }
  const audience = token.claims.aud;
  if (audience && ![GRAPH_APP_ID, GRAPH_RESOURCE, `${GRAPH_RESOURCE}/`].includes(audience)) {
    throw new SetupError(`The access token is for '${audience}', not for Microsoft Graph.`, "Use a Microsoft Graph token in ENTRA_ACCESS_TOKEN, or unset it to sign in.");
  }
  console.log(`  Signed in: upn ${claims.upn ?? "(none)"}, oid ${claims.oid ?? "(none)"}, tid ${claims.tid ?? "(none)"}${token.source === "environment" ? " (ENTRA_ACCESS_TOKEN)" : ""}`);
  if (!claims.scp.length) {
    warn(ctx, "The token has no delegated permissions (scp); this script needs a delegated user token, not an app-only token.");
    return;
  }
  console.log(indent(`scp: ${claims.scp.join(" ")}`, 2));
  const missing = scopes
    .map((scope) => scope.slice(GRAPH_RESOURCE.length + 1))
    .filter((scope) => !claims.scp.some((granted) => granted.toLowerCase() === scope.toLowerCase()));
  if (missing.length) {
    const how =
      token.source === "environment"
        ? "In Graph Explorer, consent to them (Modify permissions) and copy a new token."
        : "Sign in again and accept the consent prompt; an administrator may have to consent.";
    warn(ctx, `The token lacks ${missing.join(", ")}; steps that need them will fail with 403. ${how}`);
  }
}

/** Values for wrangler.jsonc "vars" (and the CLI); no secrets. */
function buildOutputs(ctx) {
  const tenantId = ctx.config.tenantId;
  const outputs = {};
  const interactive = ctx.results.interactive;
  if (interactive?.agentIdentity && interactive.clientApp) {
    outputs.interactive = {
      TENANT_ID: tenantId,
      BLUEPRINT_CLIENT_ID: interactive.blueprint.appId,
      AGENT_IDENTITY_ID: interactive.agentIdentity.id,
      INBOUND_REQUIRED_SCOPES: ctx.config.interactive.scopeValue,
      CLIENT_APP_ID: interactive.clientApp.appId,
    };
  }
  const autonomous = ctx.results.autonomous;
  if (autonomous?.agentIdentity) {
    outputs.autonomous = {
      TENANT_ID: tenantId,
      BLUEPRINT_CLIENT_ID: autonomous.blueprint.appId,
      AGENT_IDENTITY_ID: autonomous.agentIdentity.id,
      ...(autonomous.agentUser ? { AGENT_USER_UPN: autonomous.agentUser.userPrincipalName, AGENT_USER_ID: autonomous.agentUser.id } : {}),
    };
  }
  const echo = ctx.results.echo;
  if (echo?.app) {
    const uri = `api://${echo.app.appId}`;
    // Only this sample's agents (their blueprints) may call the echo server.
    const blueprints = [ctx.results.interactive?.blueprint?.appId, ctx.results.autonomous?.blueprint?.appId].filter(Boolean);
    outputs.echo = {
      TENANT_ID: tenantId,
      ECHO_APP_ID: echo.app.appId,
      ECHO_REQUIRED_SCOPE: ctx.config.echo.scopeValue,
      ECHO_REQUIRED_ROLE: ctx.config.echo.appRoleValue,
      ...(blueprints.length ? { ALLOWED_BLUEPRINT_IDS: blueprints.join(",") } : {}),
      ECHO_SCOPE: `${uri}/${ctx.config.echo.scopeValue}`,
      ECHO_DEFAULT_SCOPE: `${uri}/.default`,
    };
  }
  return outputs;
}

function printVars(vars) {
  const entries = Object.entries(vars);
  entries.forEach(([key, value], index) => console.log(`    "${key}": ${JSON.stringify(value)}${index < entries.length - 1 ? "," : ""}`));
}

function printSummary(outputs) {
  console.log('\n== Values for wrangler.jsonc "vars" (no secrets) ==');
  if (outputs.interactive) {
    const { CLIENT_APP_ID, ...vars } = outputs.interactive;
    console.log("\ninteractive Worker (workers/interactive/wrangler.jsonc):");
    printVars(vars);
    console.log(`  CLI client app: CLIENT_APP_ID = ${CLIENT_APP_ID} (optionally also INBOUND_ALLOWED_CLIENT_IDS)`);
    console.log(`    npm run cli -- login --tenant ${vars.TENANT_ID} --client ${CLIENT_APP_ID} --blueprint ${vars.BLUEPRINT_CLIENT_ID}`);
  }
  if (outputs.autonomous) {
    console.log("\nautonomous Worker (workers/autonomous/wrangler.jsonc):");
    printVars(outputs.autonomous);
  }
  if (outputs.echo) {
    const { ECHO_SCOPE, ECHO_DEFAULT_SCOPE, ...vars } = outputs.echo;
    console.log("\necho MCP server (workers/echo-mcp/wrangler.jsonc or workers/echo-mcp-lite/wrangler.jsonc):");
    printVars(vars);
    console.log(`  Agents calling it request "${ECHO_SCOPE}" (delegated) or "${ECHO_DEFAULT_SCOPE}" (MCP_SCOPES; required for app-only).`);
    console.log("  Its access tokens carry the Agent ID optional claims (xms_par_app_azp, xms_act_fct, xms_sub_fct, xms_tnt_fct, idtyp).");
    console.log("  If they were added just now, redeploy the agents (npm run deploy:interactive, npm run deploy:autonomous):");
    console.log("  they keep the tokens they cached before the change until those expire.");
    console.log("\n  Interactive agent, to call the echo server next to MCP Server for Enterprise (workers/interactive/wrangler.jsonc):");
    printVars({ ECHO_MCP_URL: "https://agentid-cf-echo-mcp.<your-subdomain>.workers.dev/mcp", ECHO_MCP_SCOPES: ECHO_SCOPE });
  }
  console.log("\nSecrets BLUEPRINT_CERT_PEM and BLUEPRINT_KEY_PEM come from scripts/cert/new-blueprint-cert.mjs (see docs/cloudflare-deploy-guide.md).");
}

function writeOutputs(file, tenantId, outputs) {
  let previous = {};
  if (existsSync(file)) {
    try {
      previous = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      previous = {};
    }
  }
  writeJsonFile(file, { ...previous, tenantId, updatedAt: new Date().toISOString(), ...outputs });
}

function printFailure(err) {
  const lines = [];
  if (err instanceof GraphError) {
    lines.push(`[fail] ${err.step}`, `       ${err.method} ${err.url}`);
    lines.push(`       ${err.status ? `HTTP ${err.status} ${err.code}` : err.code}: ${err.message}`);
    for (const detail of err.details) lines.push(`       ${detail}`);
    if (err.requestId) lines.push(`       request-id ${err.requestId}${err.date ? `, date ${err.date}` : ""}`);
    const hint = graphHint(err);
    if (hint) lines.push(`       Hint: ${hint}`);
  } else if (err instanceof SetupError) {
    lines.push(`[fail] ${err.message}`);
    if (err.hint) lines.push(`       Hint: ${err.hint}`);
  } else if (err instanceof EntraLoginError) {
    lines.push(`[fail] Sign-in: ${err.message.replace(/\n/g, "\n       ")}`);
  } else {
    lines.push(`[fail] Unexpected error: ${err?.stack ?? err}`);
  }
  console.error(`\n${lines.join("\n")}`);
}

function graphHint(err) {
  if (err.status === 0) return err.hint;
  if (err.status === 401) {
    return "The access token was rejected (expired, or not for Microsoft Graph). Run the script again to sign in; with ENTRA_ACCESS_TOKEN, paste a fresh delegated Graph token.";
  }
  if (err.status === 403) {
    return `Access denied (${err.code}): the signed-in user lacks a directory role, or the token lacks a delegated permission (both are listed at the start). ${err.hint ?? ""}`.trim();
  }
  if (err.status === 404) {
    return "Not found. Right after a create this is replication delay (already retried for about a minute): re-run the script. If the object was deleted, remove its entry from the state file.";
  }
  if (err.status === 429) return "Throttled by Microsoft Graph. Wait a few minutes and re-run the script.";
  if (err.status >= 500) return "Microsoft Graph returned a server error. Re-run the script; existing objects are reused.";
  if (err.status === 400 && /domain/i.test(err.message) && /userPrincipalName/i.test(err.message)) {
    return "The userPrincipalName domain must be a verified domain of the tenant (Entra admin center > Domain names).";
  }
  return err.status === 400 ? err.hint400 : undefined;
}

function finish(ctx) {
  if (ctx.actions.length) {
    console.log("\n== ACTION REQUIRED ==");
    for (const text of ctx.actions) console.log(`  - ${text}`);
  }
  if (ctx.warnings.length) console.log(`\n${ctx.warnings.length} warning(s), see [warn] above.`);
  console.log(ctx.actions.length ? "\nDone, except for the manual step(s) above." : "\nDone.");
  return ctx.actions.length ? 2 : 0;
}

// ---------------------------------------------------------------- main

async function run(args) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new SetupError(`Node.js 20 or later is required (this is ${process.versions.node}).`);

  const { config, warnings } = loadConfig(args.configFile, args);
  const sections = selectSections(config, args.only);
  const { certificates, problems } = loadCertificates(config, sections, args.dryRun, warnings);
  if (problems.length) throw new SetupError(`Cannot run:\n${problems.map((p) => `       - ${p}`).join("\n")}`);

  const allState = args.dryRun ? {} : loadStateFile(args.stateFile);
  const tenantState = isPlainObject(allState[config.tenantId]) ? allState[config.tenantId] : {};
  allState[config.tenantId] = tenantState;
  const ctx = {
    config,
    sections,
    certificates,
    dryRun: args.dryRun,
    verbose: args.verbose,
    stateFile: args.stateFile,
    state: tenantState,
    persist: () => {
      if (args.dryRun) return;
      tenantState.updatedAt = new Date().toISOString();
      writeJsonFile(args.stateFile, allState);
      ctx.saved = true;
    },
    saved: false,
    results: {},
    warnings,
    actions: [],
  };
  const scopes = computeScopes(config, sections);
  printIntro(ctx, scopes, args.configFile);

  try {
    const accessToken = args.dryRun ? undefined : await signIn(ctx, scopes, args.deviceCode);
    ctx.graph = createGraphClient({ accessToken, dryRun: args.dryRun, verbose: args.verbose });
    console.log("");
    await resolveSponsor(ctx);
    for (const section of sections) await RUNNERS[section](ctx);
  } catch (err) {
    printFailure(err);
    if (ctx.saved) {
      console.error(`\nProgress is saved in ${displayPath(args.stateFile)}. Fix the problem and re-run: existing objects are found and reused.`);
    }
    return 1;
  }

  const outputs = buildOutputs(ctx);
  printSummary(outputs);
  const outFile = join(args.outDir, `${config.tenantId}.json`);
  if (args.dryRun) {
    console.log(`\n(dry run: nothing written; a real run writes these values to ${displayPath(outFile)})`);
  } else {
    writeOutputs(outFile, config.tenantId, outputs);
    console.log(`\nWritten to ${displayPath(outFile)} (no secrets).`);
  }
  return finish(ctx);
}

/** CLI entry point; returns the exit code. */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    return await run(args);
  } catch (err) {
    printFailure(err);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
