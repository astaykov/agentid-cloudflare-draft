/**
 * The npm mirror pre-flight check, against a simulated registry that answers like npm 11's
 * `npm view --json` (checked against a real npm and a local registry).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareVersions,
  isRegistryRange,
  main,
  nativePackagesFor,
  npmCommand,
  parseView,
  rangeFloor,
} from "../scripts/check-npm-feed.mjs";

type Manifest = Record<string, unknown>;
type Registry = Record<string, Record<string, Manifest>>;

const PROJECT = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const REGISTRY_URL = "https://pkgs.dev.azure.com/contoso/_packaging/mirror/npm/registry/";

/** Public versions as of November 2026, trimmed to what the project pulls in. */
function november2026(): Registry {
  return {
    "@azure/msal-node": {
      "7.1.1": { dependencies: { "@azure/msal-common": "16.14.3", jsonwebtoken: "^9.0.0" } },
      "7.2.2": { dependencies: { "@azure/msal-common": "16.16.2", jsonwebtoken: "^9.0.0" } },
    },
    "@azure/msal-common": { "16.14.3": {}, "16.16.2": {} },
    jsonwebtoken: { "9.0.2": {} },
    "@cloudflare/workers-oauth-provider": { "1.2.0": {}, "1.2.4": {} },
    "@modelcontextprotocol/server": { "2.0.0": {}, "2.3.1": {} },
    "@modelcontextprotocol/client": { "2.3.1": {} },
    agents: {
      "0.33.0": {
        dependencies: { nanoid: "^5.1.0" },
        peerDependencies: { "@modelcontextprotocol/client": "^2.0.0", "@modelcontextprotocol/server": "^2.0.0", zod: "^4.0.0" },
        peerDependenciesMeta: { "@modelcontextprotocol/server": { optional: true } },
      },
    },
    nanoid: { "5.1.6": {} },
    zod: { "3.25.76": {}, "4.6.6": {} },
    typescript: { "5.9.3": {}, "6.0.2": {} },
    "@cloudflare/workers-types": {
      "4.20260701.1": {},
      "4.20260702.1": {},
      "5.20260703.1": {},
      "5.20260901.1": {},
      "5.20261023.1": {},
      "5.20261117.1": {},
    },
    wrangler: {
      "4.101.0": { dependencies: { workerd: "1.20260601.0", esbuild: "0.25.0" } },
      "4.158.0": {
        dependencies: { miniflare: "4.20261117.0", workerd: "1.20261117.0", esbuild: "0.28.2", unenv: "2.0.0-rc.24" },
        peerDependencies: { "@cloudflare/workers-types": "^5.20261023.1" },
        peerDependenciesMeta: { "@cloudflare/workers-types": { optional: true } },
      },
    },
    miniflare: { "4.20261117.0": { dependencies: { workerd: "1.20261117.0", sharp: "^0.35.0", undici: "7.30.1" } } },
    undici: { "7.30.1": {} },
    unenv: { "2.0.0-rc.24": {} },
    workerd: {
      "1.20261117.0": {
        optionalDependencies: {
          "@cloudflare/workerd-darwin-64": "1.20261117.0",
          "@cloudflare/workerd-darwin-arm64": "1.20261117.0",
          "@cloudflare/workerd-linux-64": "1.20261117.0",
          "@cloudflare/workerd-linux-arm64": "1.20261117.0",
          "@cloudflare/workerd-windows-64": "1.20261117.0",
        },
      },
    },
    "@cloudflare/workerd-windows-64": { "1.20261117.0": {} },
    "@cloudflare/workerd-linux-64": { "1.20261117.0": {} },
    esbuild: {
      "0.28.2": {
        optionalDependencies: { "@esbuild/win32-x64": "0.28.2", "@esbuild/win32-arm64": "0.28.2", "@esbuild/linux-x64": "0.28.2", "@esbuild/linux-arm64": "0.28.2" },
      },
    },
    "@esbuild/win32-x64": { "0.28.2": {} },
    "@esbuild/linux-x64": { "0.28.2": {} },
    sharp: {
      "0.35.1": {
        optionalDependencies: { "@img/sharp-win32-x64": "0.35.1", "@img/sharp-linux-x64": "0.35.1", "@img/sharp-libvips-linux-x64": "1.3.0", "@img/sharp-linuxmusl-x64": "0.35.1" },
      },
    },
    "@img/sharp-win32-x64": { "0.35.1": {} },
    "@img/sharp-linux-x64": { "0.35.1": {} },
    "@img/sharp-libvips-linux-x64": { "1.3.0": {} },
  };
}

// --- a small semver range matcher for the simulated registry (^, ~, comparators, ||) ---
function comparator(version: string, text: string): boolean {
  const [, op = "=", target] = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(text.trim())!;
  const cmp = compareVersions(version, target);
  const [major, minor] = target.split(".").map(Number);
  if (op === "^") return cmp >= 0 && compareVersions(version, major > 0 ? `${major + 1}.0.0-0` : `0.${minor + 1}.0-0`) < 0;
  if (op === "~") return cmp >= 0 && compareVersions(version, `${major}.${minor + 1}.0-0`) < 0;
  if (op === ">=") return cmp >= 0;
  if (op === ">") return cmp > 0;
  if (op === "<=") return cmp <= 0;
  if (op === "<") return cmp < 0;
  return cmp === 0;
}
function satisfies(version: string, range: string): boolean {
  return range.split("||").some((part) => part.trim().split(/\s+/).every((c) => comparator(version, c)));
}

/** Answers like npm 11: JSON on stdout, errors as {"error": {...}} with exit code 1. */
function simulatedNpm(registry: Registry, options: { failWith?: { code: string; summary: string } } = {}) {
  const calls: string[][] = [];
  const fail = (code: string, summary: string) => ({
    code: 1,
    stdout: JSON.stringify({ error: { code, summary, detail: "" } }, null, 2),
    stderr: `npm error code ${code}\nnpm error ${summary}\n`,
  });
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "config") return { code: 0, stdout: `${REGISTRY_URL}\n`, stderr: "" };
    if (options.failWith) return fail(options.failWith.code, options.failWith.summary);
    const [, spec, ...rest] = args;
    const fields = rest.filter((arg) => !arg.startsWith("--"));
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const range = at > 0 ? spec.slice(at + 1) : undefined;
    const versions = registry[name];
    if (!versions) return fail("E404", `Not Found - GET ${REGISTRY_URL}${name.replace("/", "%2f")} - Not found`);
    const all = Object.keys(versions).sort(compareVersions);
    const latest = all.filter((v) => !v.includes("-")).at(-1) ?? all.at(-1)!;
    const matched = range === undefined ? [latest] : all.filter((v) => satisfies(v, range));
    if (!matched.length) return fail("E404", `No match found for version ${range}`);
    if (fields.length === 1 && fields[0] === "version") {
      return { code: 0, stdout: JSON.stringify(matched.length === 1 ? matched[0] : matched, null, 2), stderr: "" };
    }
    const version = matched.at(-1)!;
    const manifest = { _id: name, name, "dist-tags": { latest }, versions: all, version, ...versions[version] };
    return { code: 0, stdout: JSON.stringify(manifest, null, 2), stderr: "" };
  };
  return { run, calls };
}

function packageFile(pkg: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-check-"));
  const file = path.join(dir, "package.json");
  writeFileSync(file, JSON.stringify(pkg, null, 2));
  return file;
}

async function check(registry: Registry, pkg: unknown, extra: { args?: string[]; platform?: string; arch?: string; failWith?: { code: string; summary: string } } = {}) {
  const npm = simulatedNpm(registry, { failWith: extra.failWith });
  const lines: string[] = [];
  const code = await main(["--package", packageFile(pkg), ...(extra.args ?? [])], {
    runNpm: npm.run,
    out: (text: string) => lines.push(...text.split("\n")),
    platform: extra.platform ?? "win32",
    arch: extra.arch ?? "x64",
  });
  return { code, text: lines.join("\n"), lines, calls: npm.calls };
}

const withRange = (name: string, range: string) => ({
  ...PROJECT,
  dependencies: { ...PROJECT.dependencies },
  devDependencies: { ...PROJECT.devDependencies, [name]: range },
});

test("the project's package.json uses @cloudflare/workers-types 5.x (4.x ended at 4.20260702.1)", () => {
  const range: string = PROJECT.devDependencies["@cloudflare/workers-types"];
  assert.match(range, /^\^5\./);
  assert.ok(satisfies("5.20261117.1", range), range);
  assert.ok(!satisfies("4.20260702.1", range), range);
});

test("the old range ^4.20260901.0 matches nothing: reported with the newer major", async () => {
  const { code, text } = await check(november2026(), withRange("@cloudflare/workers-types", "^4.20260901.0"));
  assert.equal(code, 1);
  assert.match(text, /NO MATCH +@cloudflare\/workers-types {2}\(\^4\.20260901\.0\)/);
  assert.match(text, /the newest version is 5\.20261117\.1, a newer major\. The range in package\.json is out of date\./);
  assert.match(text, /1 problem\. npm install stops at the first one/);
});

test("the project's package.json resolves fully on a registry with the November 2026 versions", async () => {
  const { code, text, calls } = await check(november2026(), PROJECT);
  assert.equal(code, 0, text);
  assert.match(text, /ok +@cloudflare\/workers-types 5\.20261117\.1/);
  assert.match(text, /ok +@azure\/msal-node 7\.2\.2/);
  assert.match(text, /ok +agents 0\.33\.0 {2}\(>=0\.26\.0 <1\.0\.0\)/);
  assert.match(text, /Native binaries for win32-x64/);
  assert.match(text, /ok +@cloudflare\/workerd-windows-64 1\.20261117\.0 {2}\(1\.20261117\.0, workerd 1\.20261117\.0\)/);
  assert.match(text, /ok +@esbuild\/win32-x64 0\.28\.2/);
  assert.match(text, /ok +@img\/sharp-win32-x64 0\.35\.1 {2}\(0\.35\.1, sharp 0\.35\.1\)/);
  assert.doesNotMatch(text, /linux|darwin|arm64/);
  assert.match(text, /Everything resolves on this registry/);
  assert.ok(calls.some((args) => args.join(" ") === "view agents@>=0.26.0 <1.0.0 version --json"), "ranges reach npm as one argument");
});

test("--verbose lists the peers: agents' required peer and wrangler's optional peer", async () => {
  const { text } = await check(november2026(), PROJECT, { args: ["--verbose"] });
  assert.match(text, /ok +@modelcontextprotocol\/client 2\.3\.1 {2}\(\^2\.0\.0, agents 0\.33\.0 \(peer, npm adds it\)\)/);
  assert.match(text, /ok +@cloudflare\/workers-types 5\.20261117\.1 {2}\(\^5\.20261023\.1, wrangler 4\.158\.0 \(optional peer\)\)/);
  assert.match(text, /ok +@azure\/msal-common 16\.16\.2 {2}\(16\.16\.2, @azure\/msal-node 7\.2\.2\)/);
  assert.match(text, /ok +undici 7\.30\.1 {2}\(7\.30\.1, miniflare 4\.20261117\.0\)/);
});

test("a mirror that stopped at 5.20260901.1 conflicts with Wrangler's optional peer (ERESOLVE)", async () => {
  const registry = november2026();
  delete registry["@cloudflare/workers-types"]["5.20261023.1"];
  delete registry["@cloudflare/workers-types"]["5.20261117.1"];
  const { code, text } = await check(registry, PROJECT);
  assert.equal(code, 1);
  assert.match(text, /CONFLICT +@cloudflare\/workers-types 5\.20260901\.1 {2}\(\^5\.20261023\.1, wrangler 4\.158\.0 \(optional peer\)\)/);
  assert.match(text, /npm stops with ERESOLVE\. This registry has no version in \^5\.20261023\.1/);
});

test("every gap is listed in one run: a missing peer, an old dependency, a missing binary", async () => {
  const registry = november2026();
  delete registry["@modelcontextprotocol/client"];
  delete registry["@azure/msal-common"]["16.16.2"];
  delete registry["@cloudflare/workerd-windows-64"];
  const { code, text } = await check(registry, PROJECT);
  assert.equal(code, 1);
  assert.match(text, /MISSING +@modelcontextprotocol\/client {2}\(\^2\.0\.0, agents 0\.33\.0 \(peer, npm adds it\)\)/);
  assert.match(text, /NO MATCH +@azure\/msal-common {2}\(16\.16\.2, @azure\/msal-node 7\.2\.2\)/);
  assert.match(text, /MISSING +@cloudflare\/workerd-windows-64 {2}\(1\.20261117\.0, workerd 1\.20261117\.0\)/);
  assert.match(text, /tries registry\.npmjs\.org directly/);
  assert.match(text, /3 problems\./);
});

test("Linux x64 checks the Linux binaries, including sharp's libvips, and not musl or arm64", async () => {
  const { code, text } = await check(november2026(), PROJECT, { platform: "linux" });
  assert.equal(code, 0, text);
  assert.match(text, /ok +@cloudflare\/workerd-linux-64 /);
  assert.match(text, /ok +@esbuild\/linux-x64 /);
  assert.match(text, /ok +@img\/sharp-linux-x64 /);
  assert.match(text, /ok +@img\/sharp-libvips-linux-x64 /);
  assert.doesNotMatch(text, /musl|arm64|windows|win32/);
});

test("an unreachable or unauthenticated registry stops early with what to fix", async () => {
  const auth = await check(november2026(), PROJECT, { failWith: { code: "E401", summary: "Unable to authenticate, need: Bearer" } });
  assert.equal(auth.code, 2);
  assert.match(auth.text, /Could not query the registry: E401/);
  assert.match(auth.text, /credential provider/);
  const network = await check(november2026(), PROJECT, { failWith: { code: "ENOTFOUND", summary: "request to https://mirror failed" } });
  assert.equal(network.code, 2);
  assert.match(network.text, /HTTPS_PROXY/);
  assert.equal(network.calls.filter((args) => args[0] === "view").length, 1, "one lookup, not one npm retry cycle per package");
});

test("--registry is passed to every npm view call", async () => {
  const { calls, text } = await check(november2026(), PROJECT, { args: ["--registry", "https://mirror.example/npm/"] });
  assert.match(text, /against https:\/\/mirror\.example\/npm\//);
  const views = calls.filter((args) => args[0] === "view");
  assert.ok(views.length > 10);
  assert.ok(views.every((args) => args.at(-1) === "--registry=https://mirror.example/npm/"));
  assert.ok(!calls.some((args) => args[0] === "config"), "no config lookup when --registry is given");
});

test("parseView reads npm 11 JSON errors and older stderr-only errors", () => {
  assert.deepEqual(parseView({ code: 0, stdout: '"7.2.2"', stderr: "" }), { ok: true, value: "7.2.2" });
  assert.deepEqual(parseView({ code: 0, stdout: '["1.0.0","1.1.0"]', stderr: "" }), { ok: true, value: ["1.0.0", "1.1.0"] });
  assert.deepEqual(parseView({ code: 0, stdout: "", stderr: "" }), { ok: true, value: null });
  const noMatch = parseView({
    code: 1,
    stdout: JSON.stringify({ error: { code: "E404", summary: "No match found for version ^4.20260901.0", detail: "" } }),
    stderr: "npm error code E404\n",
  });
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.noMatch, true);
  const notFound = parseView({ code: 1, stdout: JSON.stringify({ error: { code: "E404", summary: "Not Found - GET https://r/x - Not found" } }), stderr: "" });
  assert.equal(notFound.noMatch, false);
  assert.equal(notFound.errorCode, "E404");
  const legacy = parseView({ code: 1, stdout: "", stderr: "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for x@^9.\n" });
  assert.equal(legacy.errorCode, "ETARGET");
  assert.equal(legacy.noMatch, true);
  assert.match(legacy.summary, /No matching version found/);
  const proxy = parseView({ code: 1, stdout: "", stderr: "npm error code ECONNREFUSED\nnpm error syscall connect\n" });
  assert.equal(proxy.errorCode, "ECONNREFUSED");
});

test("versions: date-based majors, prereleases, floors and registry ranges", () => {
  assert.ok(compareVersions("5.20260703.1", "4.20260702.1") > 0);
  assert.ok(compareVersions("4.20260901.0", "4.20260702.1") > 0);
  assert.ok(compareVersions("2.0.0-rc.24", "2.0.0") < 0);
  assert.ok(compareVersions("2.0.0-beta.10", "2.0.0-beta.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.deepEqual(["0.28.2", "0.3.0", "0.25.0"].sort(compareVersions), ["0.3.0", "0.25.0", "0.28.2"]);
  assert.equal(rangeFloor("^5.20260703.1"), "5.20260703.1");
  assert.equal(rangeFloor(">=0.26.0 <1.0.0"), "0.26.0");
  assert.ok(isRegistryRange("^7.1.1") && isRegistryRange(">=0.26.0 <1.0.0") && isRegistryRange("latest"));
  assert.ok(!isRegistryRange("file:../lib") && !isRegistryRange("github:cloudflare/agents") && !isRegistryRange("cloudflare/agents"));
  assert.ok(!isRegistryRange("npm:other@^1.0.0") && !isRegistryRange("https://example.com/x.tgz"));
});

test("native binaries: the platform names workerd, esbuild and sharp use", () => {
  const optional = {
    "@cloudflare/workerd-windows-64": "1",
    "@cloudflare/workerd-linux-64": "1",
    "@cloudflare/workerd-linux-arm64": "1",
    "@cloudflare/workerd-darwin-arm64": "1",
    "@esbuild/win32-x64": "1",
    "@esbuild/win32-arm64": "1",
    "@esbuild/linux-x64": "1",
    "@img/sharp-win32-x64": "1",
    "@img/sharp-linuxmusl-x64": "1",
  };
  const names = (platform: string, arch: string) => nativePackagesFor(optional, platform, arch).map(([name]: [string, string]) => name).sort();
  assert.deepEqual(names("win32", "x64"), ["@cloudflare/workerd-windows-64", "@esbuild/win32-x64", "@img/sharp-win32-x64"]);
  assert.deepEqual(names("win32", "arm64"), ["@esbuild/win32-arm64"]);
  assert.deepEqual(names("linux", "x64"), ["@cloudflare/workerd-linux-64", "@esbuild/linux-x64"]);
  assert.deepEqual(names("darwin", "arm64"), ["@cloudflare/workerd-darwin-arm64"]);
});

test("npm is started without a shell when possible", () => {
  const yes = () => true;
  const no = () => false;
  assert.deepEqual(npmCommand({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }, "linux", "/usr/bin/node", yes), {
    command: "/usr/bin/node",
    prefix: ["/usr/lib/node_modules/npm/bin/npm-cli.js"],
    shell: false,
  });
  assert.deepEqual(npmCommand({}, "win32", "C:\\Program Files\\nodejs\\node.exe", (p: string) => p.endsWith("npm-cli.js")), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    shell: false,
  });
  assert.deepEqual(npmCommand({}, "win32", "C:\\node\\node.exe", no), { command: "npm.cmd", prefix: [], shell: true });
  assert.deepEqual(npmCommand({}, "linux", "/usr/bin/node", no), { command: "npm", prefix: [], shell: false });
});
