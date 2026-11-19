#!/usr/bin/env node
/**
 * Pre-flight check for restricted npm mirrors.
 *
 * `npm install` stops at the first package version your registry cannot serve
 * (ETARGET, E404, ERESOLVE), so a mirror with several gaps costs one round trip per gap.
 * This script asks the registry npm is configured for (npm config and .npmrc, with
 * their authentication) about everything the project installs and lists every gap
 * in one run:
 *
 *   1. each dependency and devDependency range in package.json
 *   2. what those packages pull in: their dependencies, their required peer
 *      dependencies (npm 7+ installs them) and the peers that package.json also
 *      lists (Wrangler declares an optional peer on @cloudflare/workers-types)
 *   3. Wrangler's native pieces for this machine: miniflare's dependencies and the
 *      platform packages of workerd, esbuild and sharp
 *      (@cloudflare/workerd-<platform>, @esbuild/<platform>, @img/sharp-<platform>)
 *
 *   npm run check:feed
 *   node scripts/check-npm-feed.mjs [--registry <url>] [--package <package.json>] [--verbose]
 *
 * Read-only: it runs `npm view` and `npm config get registry`, nothing else.
 * No npm packages needed; Node 22+.
 * Exit code: 0 everything found, 1 gaps found, 2 registry unreachable or usage error.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/check-npm-feed.mjs [--registry <url>] [--package <path>] [--verbose]
  --registry  check this registry instead of the one npm is configured for
  --package   the package.json to check (default: this project's)
  --verbose   also list every package that was found`;

const PROJECT_PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
const CONCURRENCY = 6;
/** Packages that ship one native binary per platform through optionalDependencies. */
const NATIVE = new Set(["workerd", "esbuild", "sharp"]);
/** Wrangler dependencies whose own dependencies are checked as well. */
const WRANGLER_CHAIN = new Set(["miniflare"]);
const PLATFORM_NAMES = { win32: ["win32", "windows"], linux: ["linux"], darwin: ["darwin"] };
const ARCH_NAMES = { x64: ["x64", "64"], arm64: ["arm64"] };
const AUTH_CODES = new Set(["E401", "E403", "ENEEDAUTH"]);
const PROBLEM = new Set(["no-match", "absent", "conflict", "error"]);
const LABEL = { ok: "ok", "no-match": "NO MATCH", absent: "MISSING", conflict: "CONFLICT", error: "ERROR", skipped: "skipped" };
const FEEDS_DOC = "docs/restricted-package-feeds.md";

// ---------------------------------------------------------------------------
// Versions

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(version).trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] } : undefined;
}

/** Semantic-version order (prereleases sort before their release). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] - y.numbers[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The lowest version written in a range ("^5.20260703.1" -> "5.20260703.1"), for hints only. */
export function rangeFloor(range) {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(range))?.[1];
}

/** True for ranges a registry answers (not file:, git, URLs, aliases or GitHub shorthands). */
export function isRegistryRange(range) {
  const value = String(range).trim();
  return !/^[a-z+]+:/i.test(value) && !/^[\w.-]+\/[\w.-]+(#.*)?$/.test(value);
}

/** The optionalDependencies that hold this machine's native binary. */
export function nativePackagesFor(optionalDependencies, platform = process.platform, arch = process.arch) {
  const tokens = [];
  for (const p of PLATFORM_NAMES[platform] ?? [platform]) for (const a of ARCH_NAMES[arch] ?? [arch]) tokens.push(`${p}-${a}`);
  return Object.entries(optionalDependencies ?? {}).filter(([name]) => tokens.some((token) => name.endsWith(`-${token}`) || name.endsWith(`/${token}`)));
}

// ---------------------------------------------------------------------------
// Running npm

/**
 * How to start npm without a shell, so ranges such as ">=0.26.0 <1.0.0" or "^5" reach it
 * unchanged: the npm that runs this script (npm run), else the npm next to node, else
 * npm from PATH (through cmd.exe on Windows).
 */
export function npmCommand(env = process.env, platform = process.platform, execPath = process.execPath, exists = existsSync) {
  const cli = env.npm_execpath;
  if (cli && /\.c?js$/i.test(cli) && exists(cli)) return { command: execPath, prefix: [cli], shell: false };
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const bundled = platform === "win32"
    ? pathApi.join(pathApi.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : pathApi.join(pathApi.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(bundled)) return { command: execPath, prefix: [bundled], shell: false };
  return platform === "win32" ? { command: "npm.cmd", prefix: [], shell: true } : { command: "npm", prefix: [], shell: false };
}

export function makeRunNpm(command = npmCommand()) {
  return (args) =>
    new Promise((resolve) => {
      const all = [...command.prefix, ...args];
      const child = spawn(command.command, command.shell ? all.map((arg) => `"${arg}"`) : all, {
        shell: command.shell,
        windowsHide: true,
        env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

function npmErrorLines(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .map((line) => /^npm (?:ERR!|error)\s?(.*)$/.exec(line)?.[1]?.trim())
    .filter((line) => line && !/^code\s/.test(line) && !/^\d{3}$/.test(line) && !/complete log of this run/i.test(line));
}

/** Reads `npm view --json` output: npm 10/11 print errors as JSON on stdout, older npm only on stderr. */
export function parseView({ code, stdout, stderr }) {
  const text = String(stdout ?? "").trim();
  let value;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
  }
  const jsonError = value && typeof value === "object" && !Array.isArray(value) && value.error && typeof value.error === "object" ? value.error : undefined;
  if (code === 0 && !jsonError) return { ok: true, value: value ?? null };
  const errorCode = jsonError?.code ?? /npm (?:ERR!|error) code (\S+)/.exec(stderr ?? "")?.[1] ?? (code === -1 ? "ENOENT" : "EUNKNOWN");
  const summary = String(jsonError?.summary ?? npmErrorLines(stderr)[0]?.replace(/^\d{3}\s+/, "") ?? `npm exited with ${code}`).trim();
  const noMatch = errorCode === "ETARGET" || (errorCode === "E404" && /no match(ing version)? found/i.test(summary));
  return { ok: false, errorCode, summary, noMatch };
}

function limiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { task, resolve, reject } = waiting.shift();
    task().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
}

// ---------------------------------------------------------------------------
// Checking

export class FeedChecker {
  constructor(runNpm, { registry, platform = process.platform, arch = process.arch } = {}) {
    this.runNpm = runNpm;
    this.registry = registry;
    this.platform = platform;
    this.arch = arch;
    this.limit = limiter(CONCURRENCY);
    this.views = new Map();
    this.seen = new Set();
  }

  view(spec, fields = []) {
    const key = [spec, ...fields].join(" ");
    if (!this.views.has(key)) {
      const args = ["view", spec, ...fields, "--json", ...(this.registry ? [`--registry=${this.registry}`] : [])];
      this.views.set(key, this.limit(() => this.runNpm(args)).then(parseView));
    }
    return this.views.get(key);
  }

  async configuredRegistry() {
    if (this.registry) return this.registry;
    const result = await this.limit(() => this.runNpm(["config", "get", "registry"]));
    return result.code === 0 ? String(result.stdout).trim().split(/\r?\n/).pop() || undefined : undefined;
  }

  /** The newest version in a range, with every version the registry has in it. */
  async resolve(name, range) {
    const result = await this.view(`${name}@${range}`, ["version"]);
    if (result.ok) {
      const versions = (result.value == null ? [] : Array.isArray(result.value) ? result.value : [result.value]).map(String).sort(compareVersions);
      return versions.length ? { status: "ok", version: versions.at(-1), versions } : { status: "no-match" };
    }
    if (result.noMatch) return { status: "no-match" };
    if (result.errorCode === "E404") return { status: "absent", summary: result.summary };
    return { status: "error", errorCode: result.errorCode, summary: result.summary };
  }

  async manifest(name, version) {
    const result = await this.view(`${name}@${version}`);
    return result.ok && result.value && typeof result.value === "object" && !Array.isArray(result.value) ? result.value : undefined;
  }

  async latest(name) {
    const result = await this.view(name, ["version"]);
    return result.ok && typeof result.value === "string" ? result.value : undefined;
  }

  async directHint(name, range, result) {
    if (result.status === "absent") return `${name} is not on this registry. Ask your mirror team to add it, or see ${FEEDS_DOC} for a fallback.`;
    if (result.status === "error") return `${result.errorCode}: ${result.summary}`;
    const latest = await this.latest(name);
    const floor = rangeFloor(range);
    if (latest && floor && parseVersion(latest) && parseVersion(floor)) {
      if (parseVersion(latest).numbers[0] > parseVersion(floor).numbers[0]) {
        return `Nothing in ${range} exists here; the newest version is ${latest}, a newer major. The range in package.json is out of date.`;
      }
      if (compareVersions(latest, floor) < 0) {
        return `The newest version here is ${latest}, older than ${range} asks for. Ask your mirror team to sync ${name}.`;
      }
    }
    return `Nothing in ${range} on this registry${latest ? ` (latest: ${latest})` : ""}.`;
  }

  /** A package that a dependency pulls in: is any version in its range available? */
  async needs(results, { name, range, via }) {
    const key = `${name}@${range}`;
    if (this.seen.has(key) || !isRegistryRange(range)) return;
    this.seen.add(key);
    const result = await this.resolve(name, range);
    const entry = { section: "transitive", name, range, via, ...result };
    if (result.status !== "ok") {
      entry.hint = result.status === "error" ? `${result.errorCode}: ${result.summary}` : `Needed by ${via}. Ask your mirror team to sync ${name} (${range}).`;
    }
    results.push(entry);
  }

  /** A peer that package.json installs itself: is there a version that satisfies both? */
  async peer(results, { name, range, via, optional, ours }) {
    const label = `${via} (${optional ? "optional " : ""}peer)`;
    const result = await this.resolve(name, range);
    const shared = result.status === "ok" ? ours.versions.filter((version) => result.versions.includes(version)) : [];
    if (shared.length) {
      results.push({ section: "transitive", status: "ok", name, range, via: label, version: shared.sort(compareVersions).at(-1) });
      return;
    }
    const fix = result.status === "ok"
      ? `This registry has ${result.version}, which fits: change the range in package.json so it includes it.`
      : `This registry has no version in ${range}: ask your mirror team to sync newer ${name} versions.`;
    results.push({
      section: "transitive",
      status: "conflict",
      name,
      range,
      via: label,
      version: ours.version,
      hint: `package.json resolves ${name} to ${ours.version}, outside the peer range ${range}; npm stops with ERESOLVE. ${fix}`,
    });
  }

  async wrangler(results, manifest, via) {
    const natives = [];
    const chain = [];
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (NATIVE.has(name)) natives.push({ name, range, via });
      if (WRANGLER_CHAIN.has(name)) chain.push({ name, range });
    }
    await Promise.all(
      chain.map(async ({ name, range }) => {
        const resolved = await this.resolve(name, range);
        if (resolved.status !== "ok") return; // reported as a dependency of wrangler
        const chainVia = `${name} ${resolved.version}`;
        const child = await this.manifest(name, resolved.version);
        await Promise.all(
          Object.entries(child?.dependencies ?? {}).map(([dependency, dependencyRange]) => {
            if (NATIVE.has(dependency)) natives.push({ name: dependency, range: dependencyRange, via: chainVia });
            return this.needs(results, { name: dependency, range: dependencyRange, via: chainVia });
          }),
        );
      }),
    );
    const unique = [...new Map(natives.map((native) => [`${native.name}@${native.range}`, native])).values()];
    await Promise.all(
      unique.map(async ({ name, range }) => {
        const resolved = await this.resolve(name, range);
        if (resolved.status !== "ok") return; // reported above
        const native = await this.manifest(name, resolved.version);
        await Promise.all(
          nativePackagesFor(native?.optionalDependencies, this.platform, this.arch).map(async ([binary, binaryRange]) => {
            const key = `${binary}@${binaryRange}`;
            if (this.seen.has(`native:${key}`)) return;
            this.seen.add(`native:${key}`);
            const result = await this.resolve(binary, binaryRange);
            const entry = { section: "native", name: binary, range: binaryRange, via: `${name} ${resolved.version}`, ...result };
            if (result.status !== "ok") {
              entry.hint = `${name} needs it to run on this machine; without it, its install step tries registry.npmjs.org directly. Ask your mirror team to sync ${binary}.`;
            }
            results.push(entry);
          }),
        );
      }),
    );
  }

  async run(pkg) {
    const direct = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const results = [];
    const resolved = new Map();
    const entries = Object.entries(direct).filter(([, range]) => isRegistryRange(range));
    if (entries.length) {
      // One lookup first: an unreachable or unauthenticated registry then costs one npm
      // retry cycle, not one per package.
      const [name, range] = entries[0];
      const probe = await this.resolve(name, range);
      if (probe.status === "error") return [{ section: "direct", name, range, ...probe }];
    }
    await Promise.all(
      Object.entries(direct).map(async ([name, range]) => {
        if (!isRegistryRange(range)) {
          results.push({ section: "direct", status: "skipped", name, range, hint: "not a registry range" });
          return;
        }
        const result = await this.resolve(name, range);
        const entry = { section: "direct", name, range, ...result };
        if (result.status === "ok") resolved.set(name, result);
        else entry.hint = await this.directHint(name, range, result);
        results.push(entry);
      }),
    );
    const manifests = new Map(await Promise.all([...resolved].map(async ([name, result]) => [name, await this.manifest(name, result.version)])));
    const work = [];
    for (const [parent, manifest] of manifests) {
      if (!manifest) continue;
      const via = `${parent} ${resolved.get(parent).version}`;
      const meta = manifest.peerDependenciesMeta ?? {};
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) work.push(this.needs(results, { name, range, via }));
      for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        const optional = meta[name]?.optional === true;
        if (name in direct) {
          if (resolved.has(name) && isRegistryRange(range)) work.push(this.peer(results, { name, range, via, optional, ours: resolved.get(name) }));
        } else if (!optional) {
          work.push(this.needs(results, { name, range, via: `${via} (peer, npm adds it)` }));
        }
      }
    }
    await Promise.all(work);
    if (manifests.get("wrangler")) await this.wrangler(results, manifests.get("wrangler"), `wrangler ${resolved.get("wrangler").version}`);
    return results;
  }
}

// ---------------------------------------------------------------------------
// Report

function line(entry) {
  const label = (LABEL[entry.status] ?? entry.status).padEnd(9);
  const version = entry.status === "ok" || entry.status === "conflict" ? ` ${entry.version}` : "";
  const detail = [entry.range, entry.via].filter(Boolean).join(", ");
  return `  ${label}${entry.name}${version}${detail ? `  (${detail})` : ""}`;
}

function byName(a, b) {
  return a.name.localeCompare(b.name) || String(a.range).localeCompare(String(b.range));
}

function registryAdvice(code) {
  if (AUTH_CODES.has(code)) return "Sign in to the registry first (for Azure Artifacts: the credential provider, or a PAT in your user .npmrc).";
  return "Check the registry URL in .npmrc, your proxy (HTTPS_PROXY) and, behind TLS inspection, NODE_EXTRA_CA_CERTS.";
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? ((text) => console.log(text));
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        registry: { type: "string" },
        package: { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    out(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const packagePath = path.resolve(options.package ?? PROJECT_PACKAGE);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    out(`Cannot read ${packagePath}: ${error.message}`);
    return 2;
  }
  const platform = io.platform ?? process.platform;
  const arch = io.arch ?? process.arch;
  const checker = new FeedChecker(io.runNpm ?? makeRunNpm(), { registry: options.registry, platform, arch });
  const registry = (await checker.configuredRegistry()) ?? "the registry npm is configured for";
  out(`Checking ${packagePath} against ${registry} (${platform}-${arch})`);

  const results = await checker.run(pkg);
  const direct = results.filter((entry) => entry.section === "direct").sort(byName);
  if (direct.length && direct.every((entry) => entry.status === "error")) {
    // Every lookup failed the same way (or the first one did and the rest were skipped).
    const { errorCode, summary } = direct[0];
    out(`\nCould not query the registry: ${errorCode} ${summary}\n${registryAdvice(errorCode)}`);
    return 2;
  }

  const print = (title, entries, all) => {
    if (!entries.length) return;
    out(`\n${title}`);
    const shown = all ? entries : entries.filter((entry) => entry.status !== "ok");
    for (const entry of shown) {
      out(line(entry));
      if (entry.hint && entry.status !== "skipped") out(`           ${entry.hint}`);
    }
    const hidden = entries.length - shown.length;
    if (hidden) out(`  ok       ${hidden} more (--verbose lists them)`);
  };
  print("package.json", direct, true);
  print("Pulled in by those packages", results.filter((entry) => entry.section === "transitive").sort(byName), options.verbose);
  print(`Native binaries for ${platform}-${arch}`, results.filter((entry) => entry.section === "native").sort(byName), true);

  const problems = results.filter((entry) => PROBLEM.has(entry.status));
  if (!problems.length) {
    out("\nEverything resolves on this registry. Run: npm install");
    return 0;
  }
  out(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}. npm install stops at the first one it meets, so fix or mirror all of them first. See ${FEEDS_DOC}.`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-npm-feed.mjs")) {
  main().then((code) => {
    process.exitCode = code;
  });
}
