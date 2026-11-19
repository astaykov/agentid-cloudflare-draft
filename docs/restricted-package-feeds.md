# Working with restricted package feeds

This sample was written for machines that can only reach mirrored copies of npm, PyPI and the
PowerShell Gallery.

* **PyPI and the PowerShell Gallery are not needed at all.** No Python, no
  Microsoft.Graph / Microsoft.Entra PowerShell modules.
* **Everything under `scripts/` uses Node.js built-ins only**: the certificate generator, the
  Entra setup script, the CLI client and the mirror check (`npm run check:feed`) run without
  `npm install`.
* **The tests** need only Node.js 22.6+ (`node --experimental-strip-types --test`).
* **npm is needed for the Workers themselves**: two runtime packages and three dev tools.

## What your npm mirror must carry

| Package | Why | Notes |
|---|---|---|
| `@azure/msal-node` **>= 7.1.0** | Token flows (FMI, OBO, user_fic) | Pulls `@azure/msal-common` and `jsonwebtoken` (+ `jws`, `jwa`, `ms`, `semver`, `lodash.*`, `safe-buffer`, `buffer-equal-constant-time`, `ecdsa-sig-formatter`). The agentic APIs need 5.3.0+. Prefer 7.1.0+: an issue in the Azure SDK repository (Azure/azure-sdk-for-js#40441) reports a security advisory for 5.0.0-beta.0 to 7.0.2, fixed in 7.1.0; confirm with your security advisory feed. |
| `agents` | Cloudflare Agents SDK (`Agent`, `getAgentByName`) | Recent versions require the peer `@modelcontextprotocol/client` (newer `@modelcontextprotocol` scope; ask your mirror team to sync it). npm 7+ installs required peers automatically. |
| `@modelcontextprotocol/server` (2.x) | Cloudflare-native echo MCP server (`McpServer`, MCP SDK v2) | Optional peer of `agents`; use the version your `agents` release expects (`npm view agents peerDependencies`). Only `workers/echo-mcp` needs it. |
| `@cloudflare/workers-oauth-provider` (1.x) | `OAuthResourceServer` guarding the native echo MCP server | Only `workers/echo-mcp`. |
| `zod` (4.x) | Tool input schemas of the native echo MCP server | Only `workers/echo-mcp`. |
| `wrangler` | Build, dev, deploy | Depends on `miniflare`, `workerd`, `esbuild`, `unenv`, `@cloudflare/unenv-preset`, `@cloudflare/kv-asset-handler`, `blake3-wasm`, `path-to-regexp`. |
| `@cloudflare/workerd-<platform>` | Native runtime binary | `windows-64`, `linux-64`, `linux-arm64`, `darwin-64`, `darwin-arm64` (optional dependencies of `workerd`) |
| `@esbuild/<platform>` | Bundler binary | e.g. `@esbuild/win32-x64` (optional dependencies of `esbuild`) |
| `@cloudflare/workers-types` **5.x** | Type checking (`npm run typecheck`) | dev only. Version 5 replaced 4.x on 3 July 2026 (the last 4.x is 4.20260702.1), so a `^4.2026...` range newer than that matches nothing anywhere. Wrangler 4.1xx declares it as an optional peer (`^5.<date>`), so the mirror needs a recent 5.x. |
| `typescript` | Type checking | dev only |

## Check the mirror before installing

`npm install` stops at the first package it cannot get, so a mirror with three gaps costs three
attempts. The project's own check asks your configured registry (your `.npmrc`, with its
authentication) about everything at once:

```bash
npm run check:feed                                   # the registry npm is configured for
npm run check:feed -- --registry https://<mirror>/npm/registry/
npm run check:feed -- --verbose                      # also list what was found
```

It needs no packages (it only runs `npm view`), so it works before the first install. It checks:

1. every range in `package.json`;
2. what those packages pull in: their dependencies, the peers npm adds for them
   (`@modelcontextprotocol/client` for `agents`) and peers `package.json` also lists (Wrangler's
   optional peer on `@cloudflare/workers-types`);
3. Wrangler's native pieces for your machine: `@cloudflare/workerd-<platform>`,
   `@esbuild/<platform>` and `@img/sharp-<platform>`, plus miniflare's dependencies.

Example: the range an early copy of this sample shipped with, against a full mirror:

```text
package.json
  ok       @azure/msal-node 7.2.2  (^7.1.1)
  NO MATCH @cloudflare/workers-types  (^4.20260901.0)
           Nothing in ^4.20260901.0 exists here; the newest version is 5.20261117.1, a newer major. The range in package.json is out of date.
  ...
1 problem. npm install stops at the first one it meets, so fix or mirror all of them first.
```

What each result means:

| Result | Meaning | Fix |
|---|---|---|
| `NO MATCH` with "a newer major" | No version in the range exists; the range is wrong | Change the range in `package.json` |
| `NO MATCH` with "older than ... asks for" | The mirror has not caught up | Ask the mirror team to sync the package |
| `MISSING` | The package is not on the mirror at all | Ask the mirror team, or use a fallback below |
| `CONFLICT` | A peer range and `package.json` have no version in common; npm stops with `ERESOLVE` | The hint says which side to change |
| Exit code 2 | The registry did not answer (address, proxy, TLS inspection) or refused (sign-in) | As printed |

On Azure Artifacts, a feed holds the versions someone already saved from its upstream sources.
Saving a new version needs the **Feed and Upstream Reader (Collaborator)** role; a **Feed Reader**
can only install what is already there. If a version is public but the check says it is missing,
ask the feed owner to save it or to grant that role.

Single packages by hand:

```bash
npm view @cloudflare/workers-types@^5.20260703.1 version
npm view agents peerDependencies
npm view @cloudflare/workerd-windows-64 version
```

After `npm install`, `npm ls --all` shows the full resolved tree if your mirror team needs a
list.

## `.npmrc`

```ini
registry=https://<your-mirror>/npm/registry/
always-auth=true
```

`.npmrc.example` has Azure Artifacts, Artifactory and Nexus forms. Authenticate the way your
organisation prescribes (for Azure Artifacts, the credential provider or a PAT).

## Things that try to reach the public internet

| What | When | What to do |
|---|---|---|
| `workerd` install script | Only if `@cloudflare/workerd-<platform>` was not installed | Keep optional dependencies on (never `--omit=optional`); the fallback downloads from `registry.npmjs.org` |
| `esbuild` install script | Same, for `@esbuild/<platform>` | As above, or set `ESBUILD_BINARY_PATH` |
| `npx wrangler` without a local install | Downloads the latest Wrangler | Use the project's devDependency (`npm run ...`) |
| Miniflare `cf.json` download | `wrangler dev` | `CLOUDFLARE_CF_FETCH_ENABLED=false` |
| `wrangler login` | Browser OAuth to dash.cloudflare.com | Or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| Wrangler API calls | deploy, secrets, tail | `HTTPS_PROXY` is honoured; `NODE_EXTRA_CA_CERTS` for TLS inspection |
| Node scripts (`scripts/`) | Entra sign-in and Graph | Node's `fetch` uses `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1` (Node 24+) |

## If a package is not available

**`agents` not mirrored.** The two agent classes use a small part of the SDK (`Agent`,
`this.env`, `this.state` / `setState`, `this.name`, `getAgentByName`). The Durable Object base
class itself ships with the Workers runtime (`cloudflare:workers`), not with npm, so you can
fall back to it:

```ts
import { DurableObject } from "cloudflare:workers";

export class InteractiveAgent extends DurableObject<InteractiveEnv> {
  // replace this.state / this.setState with this.ctx.storage.get("state") / put("state", ...)
}

// in the Worker, instead of getAgentByName(env.INTERACTIVE_AGENT, user.oid):
const agent = env.INTERACTIVE_AGENT.get(env.INTERACTIVE_AGENT.idFromName(user.oid));
```

Identity code does not change: it lives in `src/shared/entra/` and has no SDK dependency.

**MCP packages not mirrored** (`@modelcontextprotocol/server`, `@cloudflare/workers-oauth-provider`).
Deploy the dependency-free echo server instead: `npm run deploy:echo-lite`. Same tools, same Entra
Agent ID checks, same responses. The two agents never need these packages. If `npm install` itself
fails because they are missing, remove them (and `zod`) from `package.json`; `workers/echo-mcp`
then does not build, everything else does.

**`@azure/msal-node` not mirrored.** Not recommended, but the three token requests are plain
form POSTs (see [token-flows.md](token-flows.md)); the certificate assertion code in
`src/shared/entra/` is already dependency-free. You would lose MSAL's cache, retries and
protocol updates.

**Older `@azure/msal-node` only.** The agentic APIs (`fmiPath`,
`acquireTokenByUserFederatedIdentityCredential`) need 5.3.0+, and 7.1.0+ for the security fix.

**`@cloudflare/workers-types` not mirrored (or too old for Wrangler's peer range).** Remove it from
`devDependencies`. Wrangler does not type-check, so `dev` and `deploy` are unaffected; only
`npm run typecheck` needs runtime types. Wrangler can generate them instead, which is what
Cloudflare recommends for Worker projects:

```bash
npx wrangler types --include-env=false -c workers/interactive/wrangler.jsonc
```

Then set `"types": ["./worker-configuration.d.ts"]` in `tsconfig.json`.

## Dependency-free building blocks in this repo

| Module | What | Why no package |
|---|---|---|
| `src/shared/entra/certificate.ts`, `client-assertion.ts`, `der.ts` | PEM/DER, thumbprints, PS256/RS256 assertions | WebCrypto is native on Workers; avoids `node:crypto` gaps |
| `src/shared/entra/inbound-auth.ts` | Entra access-token validation (OIDC/JWKS) | No `jose` / `jsonwebtoken` needed |
| `src/shared/mcp/mcp-client.ts` | MCP Streamable HTTP client | The official v1 SDK compiles schemas at runtime (blocked on Workers) unless configured; fewer packages to mirror |
| `src/shared/entra/agent-caller.ts`, `src/echo-mcp/common.ts` | Agent ID flow classification, caller policy, the echo server's Entra guard | Shared by both echo editions |
| `src/echo-mcp-lite/` | MCP server (JSON-RPC over Streamable HTTP) | Fallback when the MCP SDK is not mirrored |
| `src/shared/cloudflare/api-shield.ts` | API Shield token configuration and WAF rule via the Cloudflare API | Plain `fetch` |
| `scripts/**` | Certificates, Entra setup, CLI | Run before or without `npm install` |
