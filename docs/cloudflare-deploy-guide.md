# Build and deploy on Cloudflare

## Prerequisites

| | |
|---|---|
| Node.js | 22 or later (current Wrangler 4 releases require it; the tests need 22.6+ for TypeScript type stripping) |
| Cloudflare account | The **Free** plan is enough to try it; **Workers Paid** ($5/month) for demos you show to others. See [Cost and the Free plan](#cost-and-the-free-plan). Durable Objects with SQLite storage are available on both plans. |
| Workers AI | Optional. Powers `/api/chat` and the autonomous `JOB_PROMPT`; billed by usage. |
| Package mirror | See [restricted-package-feeds.md](restricted-package-feeds.md) if npm can only reach an internal mirror. |
| Entra objects | Created with [entra-setup-guide.md](entra-setup-guide.md). |

## Cost and the Free plan

* **Free plan:** everything runs except the optional edge authorizer (API Shield is Enterprise-only).
  Two limits matter:
  * 10 ms CPU per invocation, Durable Object calls included. Certificate signing, MSAL and token
    validation on a cold start can go over. Occasional overruns are tolerated; if you see error
    1102 ("Worker exceeded resource limits"), move to Workers Paid.
  * 10,000 Workers AI Neurons per day; after that AI calls fail until 00:00 UTC.
* **Workers AI use:** with the default model, one chat or one autonomous run is roughly 200 to 550
  Neurons (our estimate; the Workers AI dashboard shows the real figure). Because the autonomous
  agent runs only when an operator starts it, AI use follows your demos.
* **Workers Paid:** $5 per month minimum. Demo traffic stays within the included requests, CPU
  time and Durable Object usage. Workers AI beyond 10,000 Neurons a day costs $0.011 per 1,000 Neurons.
* **Cloudflare Access** (operator sign-in): Zero Trust Free, $0 for up to 50 users.

## 1. Install

Run every command in this guide from the **project root**, the folder that contains
`package.json` (if Windows "Extract All" added an extra folder level, go one level down). There is
one `package.json` for all Workers; `workers/<name>/` holds only that Worker's `wrangler.jsonc` and
local `.dev.vars`, and the commands select a Worker with `-c workers/<name>/wrangler.jsonc`.
npm scripts (`npm run ...`, `npm test`) would also work from a subfolder, because npm always runs
them in the root, but the `npx wrangler` commands below and paths such as `certs/...` are relative
to the folder you are in. Overview: [Where to run commands and where files go](../README.md#where-to-run-commands-and-where-files-go).

```bash
cd ~/src/agentid-cloudflare   # PowerShell: cd C:\src\agentid-cloudflare (your copy, with package.json in it)
cp .npmrc.example .npmrc      # only if you need to point npm at a mirror; then edit it
npm run check:feed            # behind a mirror: lists every package it cannot serve, in one run
npm install                   # or `npm ci` once package-lock.json exists
npm test                      # local tests: certificates, assertions, token validation, MCP, tool loop
npm run typecheck
```

Always run Wrangler through the project (`npx wrangler ...` or the npm scripts). A global or
`npx` download of the latest Wrangler bypasses the version your mirror approved.

## 2. Sign Wrangler in

* Interactive: `npx wrangler login` (browser; callback on `localhost:8976`, or `--device`).
* Non-interactive or locked-down machines: create an API token from the
  **Edit Cloudflare Workers** template and set
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. These take priority over `wrangler login`.
* Behind a proxy: Wrangler honours `HTTPS_PROXY`. If the proxy inspects TLS, set
  `NODE_EXTRA_CA_CERTS` to your corporate root CA file.

## 3. Configure the Workers

Put the IDs from the Entra setup into the `vars` of each config. Nothing secret goes here.

* `workers/interactive/wrangler.jsonc`: `TENANT_ID`, `BLUEPRINT_CLIENT_ID`, `AGENT_IDENTITY_ID`;
  optionally `INBOUND_ALLOWED_CLIENT_IDS` (your CLI client app ID), `AI_MODEL`, and for the echo MCP
  server `ECHO_MCP_URL`, `ECHO_MCP_SCOPES` and the `ECHO_MCP_SERVICE` binding.
* `workers/autonomous/wrangler.jsonc`: `TENANT_ID`, `BLUEPRINT_CLIENT_ID`, `AGENT_IDENTITY_ID`,
  `AUTH_MODE`, `AGENT_USER_UPN` (or `AGENT_USER_ID`), `JOB_PROMPT` or `JOB_TOOL`. By default
  `triggers.crons` is empty: the agent runs only when an operator starts it. Add cron
  expressions (UTC) if you want a schedule, e.g. `["0 7 * * *"]`.
* `workers/echo-mcp/wrangler.jsonc` (optional, Cloudflare-native) or `workers/echo-mcp-lite/wrangler.jsonc`
  (optional, no packages): `TENANT_ID`, `ECHO_APP_ID`, `ALLOWED_BLUEPRINT_IDS`. See
  [echo-mcp-server.md](echo-mcp-server.md).

### Configuration reference

| Variable | Worker | Default | Meaning |
|---|---|---|---|
| `TENANT_ID` | all | | Directory (tenant) ID |
| `BLUEPRINT_CLIENT_ID` | agents | | Blueprint app ID |
| `AGENT_IDENTITY_ID` | agents | | Agent identity ID |
| `BLUEPRINT_CERT_PEM` | agents | secret | Certificate (PEM); Worker secret or Secrets Store binding |
| `BLUEPRINT_KEY_PEM` | agents | secret | Private key (PEM, unencrypted PKCS#8 or PKCS#1) |
| `ASSERTION_ALGORITHM` | agents | `PS256` | `PS256` (x5t#S256) or `RS256` (x5t) |
| `MSAL_LOG_LEVEL` | agents | `warning` | `error`, `warning`, `info`, `verbose` (PII logging is always off) |
| `AUTHORITY_HOST` | all | `https://login.microsoftonline.com` | Sovereign clouds |
| `MCP_SERVER_URL` | agents | MCP Server for Enterprise | Streamable HTTP endpoint (server id `enterprise` in the interactive agent) |
| `MCP_SCOPES` | agents | `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default` | Scopes requested for the MCP server |
| `ECHO_MCP_URL` | interactive | empty (off) | Second MCP server `echo`: `https://agentid-cf-echo-mcp.<subdomain>.workers.dev/mcp` |
| `ECHO_MCP_SCOPES` | interactive | empty | `api://<echo app id>/Echo.Read`; the agent gets a separate OBO token for it |
| `INBOUND_REQUIRED_SCOPES` | interactive | `access_agent` | Scope(s) the caller's token must carry |
| `INBOUND_ALLOWED_CLIENT_IDS` | interactive | empty (any) | Allow-list of calling client apps (`azp`) |
| `AI_MODEL` | agents | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model with function calling. Alternative with the same output format: `@cf/meta/llama-4-scout-17b-16e-instruct` (131,000-token context) |
| `AI_MODEL_CHOICES` | interactive | Llama 3.3 70B and Llama 4 Scout | Models `chat --model <id>` may pick for one request, comma-separated; `AI_MODEL` is always allowed |
| `CHAT_MEMORY_MINUTES` | interactive | `30` | `/api/chat` sends your last 4 turns to the model until this many minutes pass without a message; `0` = no memory |
| `AUTH_MODE` | autonomous | `agent-user` | `agent-user` or `app-only` |
| `AGENT_USER_UPN` / `AGENT_USER_ID` | autonomous | | The agent user (agent-user mode) |
| `JOB_PROMPT` | autonomous | sample question | Run with Workers AI and the MCP tools |
| `JOB_TOOL`, `JOB_TOOL_ARGUMENTS` | autonomous | empty | Without Workers AI: one tool call per run (JSON arguments) |
| `ADMIN_AUTH` | autonomous | `admin-key` | `admin-key` or `access` (Cloudflare Access in front of the Worker, see below) |
| `ACCESS_AUD` | autonomous | | AUD tag of the Access application (`ADMIN_AUTH=access`) |
| `ADMIN_KEY` | autonomous | secret | `admin-key` mode: protects `/status` and `/run`; both are off when unset |
| `MCP_SERVICE` | agents | binding, optional | Service binding to the `MCP_SERVER_URL` server's Worker (private path; the token is still sent) |
| `ECHO_MCP_SERVICE` | interactive | binding, optional | Service binding to the echo MCP server Worker; needed when both Workers are on the same zone (error 1042) |
| `ECHO_APP_ID`, `ECHO_REQUIRED_SCOPE`, `ECHO_REQUIRED_ROLE` | echo | | Echo MCP server audience, scope and app role |
| `REQUIRE_AGENT_CALLER`, `ALLOWED_CALLER_FLOWS`, `ALLOWED_BLUEPRINT_IDS`, `ALLOWED_AGENT_IDS` | echo | agents only | Caller policy ([echo-mcp-server.md](echo-mcp-server.md#caller-policy)) |
| `ECHO_RESOURCE_URL`, `ECHO_ALLOWED_HOSTNAMES` | echo (native) | request origin | Public `/mcp` URL and Custom Domain host names |
| `AGENT_RATE_LIMITER` | echo | binding, optional | Workers Rate Limiting per agent identity (`ratelimits` block) |

## 4. Deploy and add the secrets

```bash
npm run deploy:interactive
npm run deploy:autonomous
npm run deploy:echo            # optional
```

Then store the certificates, still from the project root (each `secret put` creates and deploys a
new version):

```bash
# bash / zsh
npx wrangler secret put BLUEPRINT_CERT_PEM -c workers/interactive/wrangler.jsonc < certs/interactive-blueprint/interactive-blueprint.cert.pem
npx wrangler secret put BLUEPRINT_KEY_PEM  -c workers/interactive/wrangler.jsonc < certs/interactive-blueprint/interactive-blueprint.key.pem
npx wrangler secret put BLUEPRINT_CERT_PEM -c workers/autonomous/wrangler.jsonc  < certs/autonomous-blueprint/autonomous-blueprint.cert.pem
npx wrangler secret put BLUEPRINT_KEY_PEM  -c workers/autonomous/wrangler.jsonc  < certs/autonomous-blueprint/autonomous-blueprint.key.pem
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ADMIN_KEY -c workers/autonomous/wrangler.jsonc
```

```powershell
# PowerShell
Get-Content certs\interactive-blueprint\interactive-blueprint.cert.pem -Raw | npx wrangler secret put BLUEPRINT_CERT_PEM -c workers/interactive/wrangler.jsonc
Get-Content certs\interactive-blueprint\interactive-blueprint.key.pem  -Raw | npx wrangler secret put BLUEPRINT_KEY_PEM  -c workers/interactive/wrangler.jsonc
Get-Content certs\autonomous-blueprint\autonomous-blueprint.cert.pem   -Raw | npx wrangler secret put BLUEPRINT_CERT_PEM -c workers/autonomous/wrangler.jsonc
Get-Content certs\autonomous-blueprint\autonomous-blueprint.key.pem    -Raw | npx wrangler secret put BLUEPRINT_KEY_PEM  -c workers/autonomous/wrangler.jsonc
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ADMIN_KEY -c workers/autonomous/wrangler.jsonc
```

Once stored, delete the local `.key.pem` files (or keep them in your vault only).

## 5. Test

```bash
# configuration + certificate (no token needed)
curl https://agentid-cf-interactive.<your-subdomain>.workers.dev/healthz

# interactive: sign in once (the CLI remembers the agent URL), then call the agent
npm run cli -- login --tenant <tenant-id> --client <cli-client-app-id> --blueprint <interactive-blueprint-app-id> --agent https://agentid-cf-interactive.<your-subdomain>.workers.dev
npm run cli -- whoami
npm run cli -- tools
npm run cli -- chat "How many users are in my tenant?"
npm run cli -- chat --new "How many guest users are there?"                  # --new: forget the earlier turns first
npm run cli -- chat --new --debug "Ask the echo server who is calling it"     # --debug: each model step
npm run cli -- chat --new --model @cf/meta/llama-4-scout-17b-16e-instruct "How many groups are there?"   # another model, no redeploy

# autonomous: start a run (it has no schedule by default) and read the results
export AUTONOMOUS_URL=https://agentid-cf-autonomous.<your-subdomain>.workers.dev
export AUTONOMOUS_ADMIN_KEY=<ADMIN_KEY>          # ADMIN_AUTH=admin-key
npm run autonomous:run                           # waits for the run; prints token claims, tool calls, answer
npm run autonomous:status -- --last 3
# the same with curl: curl -X POST -H "x-admin-key: <ADMIN_KEY>" $AUTONOMOUS_URL/run
```

```powershell
# PowerShell (Windows PowerShell 5.1: type curl.exe, because curl is an alias for Invoke-WebRequest)
curl.exe https://agentid-cf-interactive.<your-subdomain>.workers.dev/healthz
npm run cli -- login --tenant <tenant-id> --client <cli-client-app-id> --blueprint <interactive-blueprint-app-id> --agent https://agentid-cf-interactive.<your-subdomain>.workers.dev
npm run cli -- whoami

$env:AUTONOMOUS_URL = "https://agentid-cf-autonomous.<your-subdomain>.workers.dev"
$env:AUTONOMOUS_ADMIN_KEY = "<ADMIN_KEY>"        # ADMIN_AUTH=admin-key
npm run autonomous:run
npm run autonomous:status -- --last 3
```

With `ADMIN_AUTH=access` (section 7), use your own Access sign-in or a service token instead of the key:

```bash
cloudflared access login $AUTONOMOUS_URL
export CF_ACCESS_TOKEN=$(cloudflared access token -app=$AUTONOMOUS_URL)
npm run autonomous:run
# automation: export CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... (Access service token)
```

```powershell
# PowerShell
cloudflared access login $env:AUTONOMOUS_URL
$env:CF_ACCESS_TOKEN = cloudflared access token "-app=$env:AUTONOMOUS_URL"
npm run autonomous:run
# automation: $env:CF_ACCESS_CLIENT_ID = "..."; $env:CF_ACCESS_CLIENT_SECRET = "..." (Access service token)
```

A second run request while one is in progress gets 409, so a double click does not spend
tokens and Workers AI quota twice.

The CLI caches your access token (one hour, audience = your blueprint) in
`.agent-cli/session.json` with owner-only permissions so you are not prompted on every command.
Use `--no-cache` to avoid that, and `npm run cli -- logout` to delete it. To bring your own
token instead of signing in, set `ENTRA_ACCESS_TOKEN`.

What to look for in `whoami`:

* `tokens.inbound.aud` = your blueprint app ID, `scp` = `access_agent`.
* `tokens.leg1_fmi_credential` is the blueprint's token for the agent identity (T1).
* `tokens.leg2_on_behalf_of.enterprise.azp` = the **agent identity**, `oid` = **you**, `aud` = the
  MCP server, `scp` = the MCP scopes. The Agent ID claims (`xms_act_fct`, `xms_par_app_azp`) appear
  only if that resource's app registration lists them as optional claims.
* With the echo server configured, `tokens.leg2_on_behalf_of.echo` is a second OBO token: the same
  `azp` and `oid`, `aud` = the echo app, `scp` = `Echo.Read`, and `xms_par_app_azp` = the
  interactive blueprint, `xms_act_fct` = 11, `idtyp` = `user` (optional claims of the echo app,
  added by `npm run entra:setup`). A failed exchange shows its error there.

Logs: `npx wrangler tail -c workers/interactive/wrangler.jsonc`, or Workers Observability in
the dashboard. Only AADSTS codes and correlation IDs are logged, never tokens.

## 6. Local development

Wrangler reads local secrets from a `.dev.vars` file in the same folder as the `wrangler.jsonc` it
was given, so each Worker has its own `workers/<name>/.dev.vars`; a `.dev.vars` in the project root is
not used. From the project root:

```bash
cp workers/interactive/.dev.vars.example workers/interactive/.dev.vars
cp workers/autonomous/.dev.vars.example workers/autonomous/.dev.vars
# paste the two lines from certs/interactive-blueprint/interactive-blueprint.dev.vars into the first,
# those from certs/autonomous-blueprint/autonomous-blueprint.dev.vars into the second (plus ADMIN_KEY)
npm run dev:interactive        # http://localhost:8787
npm run dev:autonomous         # http://localhost:8788 (second terminal)
AUTONOMOUS_ADMIN_KEY=<ADMIN_KEY from .dev.vars> npm run autonomous:run -- --url http://localhost:8788
# PowerShell: $env:AUTONOMOUS_ADMIN_KEY = "<ADMIN_KEY from .dev.vars>"; npm run autonomous:run -- --url http://localhost:8788
```

* Entra, the MCP server and Workers AI are real remote services during `wrangler dev`
  (Workers AI needs `wrangler login` and is billed).
* The Worker's own outbound `fetch` in local dev does **not** use `HTTPS_PROXY`
  (workers-sdk issue #4515). If your network only allows proxied egress, test the deployed
  Workers instead.
* Start the autonomous job with `POST /run` (needs `ADMIN_KEY` in `.dev.vars`). If you add a
  schedule, test the cron path with the route that `--test-scheduled` exposes
  (`/cdn-cgi/local/scheduled` in current Wrangler; older versions use `/cdn-cgi/handler/scheduled`
  or `/__scheduled`). Local development never runs schedules on its own.

## 7. Optional: Cloudflare built-ins

Details and the reasoning: [cloudflare-built-ins.md](cloudflare-built-ins.md).

**Echo MCP server.** `npm run deploy:echo` (Cloudflare-native) or `npm run deploy:echo-lite`. No
secrets. The interactive agent adds it as a second MCP server with `ECHO_MCP_URL`,
`ECHO_MCP_SCOPES` and the `ECHO_MCP_SERVICE` binding ([README](../README.md#the-echo-mcp-server)).
Point the autonomous agent at it with `AUTH_MODE=app-only`,
`MCP_SERVER_URL=https://agentid-cf-echo-mcp.<subdomain>.workers.dev/mcp`,
`MCP_SCOPES=api://<echo app id>/.default` and the `MCP_SERVICE` binding. Details:
[echo-mcp-server.md](echo-mcp-server.md#deploy-and-connect-the-agents).

**Cloudflare Access for the autonomous agent's operators** (instead of `ADMIN_KEY`):

1. Zero Trust: add Microsoft Entra ID as an identity provider (Settings > Authentication).
2. Workers & Pages > `agentid-cf-autonomous` > **Access** > *Protect this Worker behind Access*,
   *All traffic*, with a policy for your operators (and, for automation, a Service Auth policy
   with an Access service token).
3. Copy the application's **AUD tag** (Zero Trust > Access > Applications > the app > Additional
   settings) into `ACCESS_AUD`, set `ADMIN_AUTH` to `access`, deploy. Remove the `ADMIN_KEY` secret.
4. Operators open `https://agentid-cf-autonomous.<subdomain>.workers.dev/status` in a browser, or
   start runs with `npm run autonomous:run` after `cloudflared access login` (section 5). Scripts
   send an Access service token (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`).
   The run record shows who started each run, e.g. `manual (access:alice@contoso.com)`.

Scheduled runs (if you add a cron) are not HTTP requests and are not affected. Local test: uncomment the `access.dev`
block in the autonomous `wrangler.jsonc`.

**Private path to the MCP server.** Uncomment the `services` block in an agent's `wrangler.jsonc`
(`ECHO_MCP_SERVICE` on the interactive agent, `MCP_SERVICE` on the autonomous agent). Keep the URL
variables on the MCP server's public URL. Use it whenever the agent and the MCP server are Workers on
the same zone, including your workers.dev subdomain: a plain `fetch()` between them fails with error
1042 unless the calling Worker has the `global_fetch_strictly_public` compatibility flag.

**Edge authorizer** (Enterprise + API Shield): `npm run edge:setup:dry-run`, `npm run edge:setup`,
`npm run deploy:jwks-sync`; needs Custom Domains (`workers_dev: false`) for the protected Workers.

## Updating and removing

* Changing `vars` or code: deploy again. Secrets survive deployments.
* The Durable Object classes are declared once (`migrations` tag `v1`). Renaming a class
  needs a new migration.
* Schedule: `"crons": []` (the default) means manual runs only. Deploying replaces the schedules
  with the list; an empty list removes them, while deleting the `crons` key leaves the deployed
  ones in place. Changes can take up to 15 minutes to reach the whole network.
* Delete everything: `npx wrangler delete -c workers/<name>/wrangler.jsonc`, then remove the
  Entra objects (blueprints, agent identities, agent user, app registrations).

## Troubleshooting

| Symptom | Look at |
|---|---|
| `npm error enoent Could not read package.json` | You are outside the project, often one folder above it after Windows "Extract All". `cd` into the folder that contains `package.json` |
| `npx wrangler ... -c workers/<name>/wrangler.jsonc` cannot find the config file, or the shell cannot find `certs/...` | Both paths are relative to the current folder; run the command from the project root |
| `configuration_error` naming `BLUEPRINT_CERT_PEM` / `BLUEPRINT_KEY_PEM` under `npm run dev:*` | `.dev.vars` is missing or in the wrong folder; it belongs in `workers/<name>/`, next to that Worker's `wrangler.jsonc` |
| `configuration_error` from any endpoint | A `vars` value is not a GUID or a secret is missing; the message lists all problems |
| `/healthz` says the key does not match the certificate | `BLUEPRINT_KEY_PEM` and `BLUEPRINT_CERT_PEM` come from different pairs |
| 401 from the interactive Worker | The `WWW-Authenticate` header and body name the failed check (audience, scope, v1 token...) |
| 502 `token_acquisition_failed` | `stage` tells which leg failed, `aadsts` the Entra error; see [token-flows.md](token-flows.md#common-errors) |
| 502 `mcp_http_error` 401/403 | The MCP server rejected the token; `wwwAuthenticate` explains why. Check the grants. |
| `/api/chat` 501 | Add the `ai` binding |
| Echo server 403 `access_denied`, "no Agent ID claims" | The echo app registration does not list the Agent ID optional claims (`xms_par_app_azp`, `xms_act_fct`, `xms_sub_fct`); run `npm run entra:setup -- --only echo`, then redeploy the agent so it drops its cached token |
| Echo server 403 `access_denied`, other message | Valid token, refused by the caller policy: a blueprint, agent or flow not in the allow-lists |
| `chat` answers an earlier question again | The model saw the earlier turns of your conversation. Use `chat --new` (or `reset`); turns older than `CHAT_MEMORY_MINUTES` are dropped automatically |
| `chat` answers "Your input is incomplete..." (or similar) and lists no tool calls | The model did not call a tool, even after the agent asked once more. `chat --debug` shows each model step; `npm run cli -- call --server echo --tool whoami` checks the identity chain without the model. Compare models with `chat --model @cf/meta/llama-4-scout-17b-16e-instruct` and make the better one `AI_MODEL` |
| `chat` answers with a tool call such as `echo_server_whoami()` or `[echo_server_whoami {}]` | The model wrote the call as text. The agent runs such calls (`chat --debug` marks them "written as text, run anyway") and, when the model repeats a call instead of answering, shows the last tool result. A raw call as the answer means an older deployment of the interactive agent: deploy it again |
| `error code: 1042` when an agent calls the echo server | Plain `fetch()` between two Workers on the same zone; add the service binding. More echo errors: [echo-mcp-server.md](echo-mcp-server.md#troubleshooting-the-interactive-agent-to-echo-call) |
| Echo server 403 `"Missing Host header"` (JSON-RPC error -32000) | A service binding call without a `Host` header, refused by `createMcpHandler`'s DNS rebinding check on workers.dev. The sample's agents send the host on binding calls and the echo server fills a missing one: deploy both again from this version. A client of your own must set `Host` to the URL's host on binding calls |
| Echo server 503 | It could not fetch the tenant's signing keys (egress, `TENANT_ID`) |
| `/status` 403 `access_required` | `ADMIN_AUTH=access` but the request did not come through Access (Worker not protected, or a service binding call) |
| 401 JSON "Rejected at the Cloudflare edge" | The API Shield rule blocked it: no valid Entra token for that host's audience; see Security > Events |
| Errors about CPU time | Use Workers Paid, or set `limits.cpu_ms` |
| Wrangler warns the compatibility date is newer than its runtime | Your mirrored Wrangler is older than the config; update it, or lower `compatibility_date` (keep `nodejs_compat`; 2025-09-01 or later) |
| `npm install` fails on `@cloudflare/workerd-*` or `@esbuild/*` | The mirror lacks the platform package; see [restricted-package-feeds.md](restricted-package-feeds.md) |
| `npm install`: `ETARGET No matching version found for <package>@<range>` | Either no published version fits the range, or the mirror does not have it yet. `npm run check:feed` tells the two apart and lists every other gap too. For `@cloudflare/workers-types`, version 5 replaced 4.x on 3 July 2026, so any `^4.2026...` range newer than that matches nothing; the sample asks for `^5.20260703.1` |
| `npm install`: `ERESOLVE` on `@cloudflare/workers-types` | Wrangler 4.1xx declares it as an optional peer `^5.<date>`; the mirror's newest 5.x is older than that. Sync a newer 5.x, or remove the package (only `npm run typecheck` uses it) |
