#!/usr/bin/env node
/**
 * Edge "authorizer" for the sample's Workers: Cloudflare API Shield JWT
 * validation with Microsoft Entra ID keys, plus one WAF custom rule per host
 * that requires a valid Entra token for that host's API (issuer, audience and,
 * optionally, the agent's blueprint). Enterprise plan with API Shield only.
 *
 *   CLOUDFLARE_API_TOKEN=... npm run edge:setup -- [--dry-run]
 *
 * Config: scripts/cloudflare/edge.config.json (copy edge.config.example.json).
 * API token permissions: Zone > API Gateway: Edit, Zone > Zone WAF: Edit.
 * Idempotent: re-running updates the keys and the rules in place.
 *
 * Needs Node 22.6+ (imports a TypeScript module with --experimental-strip-types,
 * which the npm script passes). No npm packages.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  edgeRule,
  ensureCustomRule,
  ensureTokenConfiguration,
  entraSigningKeys,
} from "../../src/shared/cloudflare/api-shield.ts";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

function fail(message) {
  console.error(`\nerror: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "scripts/cloudflare/edge.config.json" },
    "dry-run": { type: "boolean", default: false },
    "keys-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log("Usage: CLOUDFLARE_API_TOKEN=... node --experimental-strip-types scripts/cloudflare/setup-edge-jwt-validation.mjs [--config file] [--dry-run] [--keys-only]");
  process.exit(0);
}

let config;
try {
  config = JSON.parse(await readFile(values.config, "utf8"));
} catch (err) {
  fail(`cannot read ${values.config}: ${err.message}. Copy scripts/cloudflare/edge.config.example.json first.`);
}
const { zoneId, tenantId, action = "log", hosts = [] } = config;
const title = config.tokenConfigurationTitle || `Entra ID ${tenantId}`.slice(0, 50);
const authorityHost = (config.authorityHost || "https://login.microsoftonline.com").replace(/\/+$/, "");
if (!/^[0-9a-f]{32}$/i.test(zoneId ?? "")) fail("zoneId must be the 32-character zone ID");
if (!GUID.test(tenantId ?? "")) fail("tenantId must be a GUID");
if (!["log", "block"].includes(action)) fail('action must be "log" or "block"');
if (!values["keys-only"]) {
  if (!hosts.length) fail("hosts is empty");
  for (const h of hosts) {
    if (!HOST.test(h.host ?? "")) fail(`invalid host '${h.host}'`);
    if (!GUID.test(h.audience ?? "")) fail(`host ${h.host}: audience must be the Entra app (client) ID`);
    for (const b of h.allowedBlueprints ?? []) if (!GUID.test(b)) fail(`host ${h.host}: allowedBlueprints entry '${b}' is not a GUID`);
  }
}
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken && !values["dry-run"]) fail("set CLOUDFLARE_API_TOKEN (Zone > API Gateway: Edit, Zone > Zone WAF: Edit)");
const api = { apiToken: apiToken ?? "", apiBase: process.env.CLOUDFLARE_API_BASE };
const issuer = `${authorityHost}/${tenantId}/v2.0`;

console.log(`Entra issuer: ${issuer}`);
let keys;
try {
  keys = await entraSigningKeys(tenantId, authorityHost);
} catch (err) {
  fail(`could not read the tenant's signing keys from ${authorityHost}: ${err.cause?.message ?? err.message}`);
}
console.log(`Entra signing keys: ${keys.length} (${keys.map((k) => k.kid).join(", ")})`);

if (values["dry-run"]) {
  console.log(`\n[dry run] token configuration '${title}': create or update with ${keys.length} keys`);
  for (const h of values["keys-only"] ? [] : hosts) {
    const rule = edgeRule("<token-configuration-id>", issuer, h, action);
    console.log(`\n[dry run] WAF custom rule ${rule.ref} (${action}) for ${h.host}:\n  ${rule.expression}`);
  }
  process.exit(0);
}

process.on("unhandledRejection", (err) => fail(err?.message ?? String(err)));

const tokenConfig = await ensureTokenConfiguration(api, zoneId, title, `Microsoft Entra ID signing keys for tenant ${tenantId} (Entra Agent ID sample)`, keys);
console.log(`${tokenConfig.created ? "created" : "updated"}: token configuration ${tokenConfig.id}`);

if (!values["keys-only"]) {
  for (const h of hosts) {
    const rule = edgeRule(tokenConfig.id, issuer, h, action);
    const result = await ensureCustomRule(api, zoneId, rule);
    console.log(`${result.created ? "created" : "updated"}: WAF custom rule ${rule.ref} (${action}) for ${h.host}`);
  }
}

console.log(`
Next:
  * Keep the keys current: deploy the sync Worker (workers/edge-jwks-sync/wrangler.jsonc) with
      ZONE_ID=${zoneId}  TOKEN_CONFIG_ID=${tokenConfig.id}  TENANT_ID=${tenantId}
    and the secret CF_API_TOKEN (Zone > API Gateway: Edit).
  * Watch Security > Events, then switch "action" to "block" and run this again.`);
