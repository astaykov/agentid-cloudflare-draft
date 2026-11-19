# Cloudflare built-ins for Entra Agent ID

Cloudflare has no single switch that checks an Entra token before an agent on Workers or the Agents
SDK runs. The job is split across a few built-in layers. This page lists them, says which ones this
sample uses, and explains why some popular Cloudflare features do **not** fit Entra Agent ID.

State: November 2026.

## The rule that decides what fits

Every Cloudflare layer either **validates** an Entra token or **issues its own** token.

* **Validators keep the identity chain intact.** The interactive agent's on-behalf-of request needs
  the user's Entra token whose audience is the blueprint; a Cloudflare-issued token cannot be
  exchanged. The MCP server can only see *which agent, of which blueprint, for which user* if it
  receives the Entra token (`azp`, `xms_par_app_azp`, `xms_act_fct`, `xms_sub_fct`, `oid`).
* **Issuers break it.** Cloudflare Access Managed OAuth, Access for SaaS, MCP server portals and
  `OAuthProvider` as an authorization server all hand the client a Cloudflare token. Behind them
  the agent identity, its blueprint and the user are gone.

So Entra stays the only token issuer, and Cloudflare is used to host, validate, isolate, throttle and log.

## Overview

| Need | Cloudflare built-in | Where it runs | Plan | In this sample |
|---|---|---|---|---|
| Check the caller's Entra token before the agent runs | Validation in the Worker before the Agent (Durable Object) is touched | Worker | All | Always: `src/shared/entra/inbound-auth.ts` (interactive agent) and the echo MCP server |
| The same check at the edge | **API Shield JWT validation** and a **WAF custom rule** on issuer, audience and `xms_par_app_azp` | Zone edge, before the Worker (Custom Domains, routes) | Enterprise + API Shield | Optional: `npm run edge:setup` ([below](#edge-authorizer-api-shield-jwt-validation)) |
| Protect an MCP endpoint | **`OAuthResourceServer`** (`@cloudflare/workers-oauth-provider`) and **`createMcpHandler`** (Agents SDK) with an Entra `validateToken` | Worker | All | The echo MCP server ([echo-mcp-server.md](echo-mcp-server.md)) |
| Let operators start the autonomous agent | **Cloudflare Access on the Worker**; the Worker reads the platform-validated `ctx.access` | Access, before the Worker | Zero Trust (Free up to 50 users) | `ADMIN_AUTH=access` |
| A workload identity for the blueprint | **None.** Workers, Durable Objects, Agents and Containers get no platform-signed identity token | - | - | A certificate on the blueprint ([certificate-auth.md](certificate-auth.md)) |
| Store the certificate and key | Worker secrets; **Secrets Store** (open beta, up to 64 KB per secret) | Binding | All | Both supported |
| Run on a schedule | **Cron Triggers** | Worker | All (5 per account on Free) | Optional; by default an operator starts each run |
| Call another Worker privately | **Service bindings** (Worker to Worker, no public hop) | Cloudflare network | All | `ECHO_MCP_SERVICE` (interactive) and `MCP_SERVICE` (autonomous) to the echo MCP server |
| Throttle per agent | **Workers Rate Limiting binding** keyed by agent identity; WAF rate limiting by JWT claim | Worker; edge | All; Enterprise + API Shield | The echo MCP server's `AGENT_RATE_LIMITER` (opt-in) |
| Audit | **Workers Logs**, Logpush, Tail Workers | Platform | All; Paid | One token-free audit line per MCP tool call |
| Hold or broker outbound tokens | No equivalent for Entra Agent ID | - | - | MSAL in the Worker, cache per isolate |

## What the sample uses

### 1. Cloudflare's MCP tooling as the MCP server's authorizer

The echo MCP server is built the way Cloudflare builds remote MCP servers in 2026:

* `createMcpHandler` from `agents/mcp/server` (stateless, MCP TypeScript SDK v2, one `McpServer` per request);
* wrapped in `OAuthResourceServer` from `@cloudflare/workers-oauth-provider` 1.x, the
  *resource-server* role of that library (no KV, no authorize/token endpoints).

`OAuthResourceServer` publishes the RFC 9728 metadata (pointing MCP clients to Entra), answers
401 with a `WWW-Authenticate` challenge, calls our `validateToken`, enforces audience and expiry, and
hands the result to the MCP handler as `ctx.props` and `ctx.auth`. Our `validateToken` is the Entra
Agent ID check: signature, issuer, audience, scope or app role, which flow (OBO, app-only, agent
user), and a caller policy (agents only, allowed blueprints and agent identities). Tools read the
caller with `getMcpAuthContext()`; `context.http.authInfo.clientId` is the calling agent identity.

Cloudflare's own docs call accepting another issuer's tokens "at your own risk": the library still
enforces audience and expiry, everything else about the token is your code. That is exactly the
part this sample provides.

### 2. Cloudflare Access for the people who operate the autonomous agent

Since August 2026 Access can protect a Worker directly (Workers > your Worker > Access): every
request is checked before the Worker runs, across workers.dev, routes, Custom Domains and previews.
With Entra ID as the Access identity provider, operators sign in with their Entra account;
automation uses an Access service token. The Worker does not parse a JWT: `ctx.access` exists only
when Access authenticated the request, and `ctx.access.aud` names the Access application.

Set `ADMIN_AUTH=access` and `ACCESS_AUD=<the application's AUD tag>` in
`workers/autonomous/wrangler.jsonc`. The run record shows who triggered a manual run
(`manual (access:alice@contoso.com)`). Limits worth knowing:

* `ctx.access` does not cross service bindings or RPC, and is missing in Workers with Static Assets.
* Worker-level Access policies refuse WebSocket upgrades (403); use a hostname-based Access
  application for WebSocket agents.
* For local tests, `wrangler dev` simulates `ctx.access` with an `"access": { "dev": { "aud": ..., "identity": {...} } }`
  block (commented out in the autonomous `wrangler.jsonc`).

Access is **not** used in front of the interactive agent's API or the MCP server: those must receive
Entra tokens (see the rule above).

### 3. Workers platform features

* **Service bindings.** Set `"services": [{ "binding": "ECHO_MCP_SERVICE", "service": "agentid-cf-echo-mcp" }]`
  on the interactive agent (or `MCP_SERVICE` on the autonomous agent) and its MCP calls go Worker to
  Worker. The Entra token is still sent and validated. Keep the URL variable on the public `/mcp` URL
  (path and host). Between two Workers on the same zone, such as your workers.dev subdomain, this is
  the way to call: a plain `fetch()` fails with error 1042 unless the caller sets the
  `global_fetch_strictly_public` compatibility flag.
* **The `Host` header on binding calls.** A call through a service binding carries only the headers
  the caller set, so it has no `Host` header unless the caller adds one, and `createMcpHandler`
  refuses such a call on workers.dev with `403 "Missing Host header"` (its DNS rebinding check). The
  sample's MCP client sends the host of the server URL on binding calls, and the echo server gives a
  call without `Host` the host of its URL. A `Host` that is present is never changed.
* **Rate limiting.** Uncomment `ratelimits` in `workers/echo-mcp/wrangler.jsonc` to limit requests per
  agent identity (`azp`). Limits are approximate and per Cloudflare location.
* **Durable Objects (Agents SDK), Workers AI, Secrets Store and Workers Logs** run the agents;
  **Cron Triggers** only if you give the autonomous agent a schedule.

## Edge authorizer: API Shield JWT validation

Cloudflare verifies the Entra token at the edge, before the Worker runs, and a WAF custom rule blocks
(or logs) requests without a valid token **for this API**.

* **Checks:** signature against keys you upload, `exp` and `nbf` (60 s tolerance). The token
  configuration does not check `iss` or `aud`; the custom rule does, with
  `lookup_json_string(http.request.jwt.claims["<config id>"][0], "<claim>")`, and optionally
  `xms_par_app_azp` (only agents, or only agents of given blueprints). `xms_par_app_azp` is an
  optional claim: it is only in the token when the protected API's app registration lists it
  (`npm run entra:setup` does this for the echo app).
* **Keys are pushed, not fetched.** API Shield does not read JWKS URLs. The setup script uploads the
  tenant's current signing keys; the `edge-jwks-sync` Worker refreshes them every 30 minutes (Entra
  publishes new keys before it uses them).
* **Plan:** Enterprise with API Shield (Enterprise customers can preview it).
* **Coverage:** requests to Custom Domains or routes in the zone. Not covered: `*.workers.dev`,
  service-binding calls, and same-zone `fetch()` from another Worker unless that Worker has the
  `global_fetch_strictly_public` compatibility flag. Put the protected Workers on Custom Domains with
  `"workers_dev": false`. The Worker keeps validating every token either way.

From the project root (the folder with `package.json`):

```bash
cp scripts/cloudflare/edge.config.example.json scripts/cloudflare/edge.config.json   # zone, tenant, hosts, audiences
export CLOUDFLARE_API_TOKEN=...      # Zone > API Gateway: Edit, Zone > Zone WAF: Edit; PowerShell: $env:CLOUDFLARE_API_TOKEN = "..."
npm run edge:setup:dry-run           # shows the keys and the exact rule expressions
npm run edge:setup                   # token configuration + one WAF custom rule per host ("log" first)
npm run deploy:jwks-sync             # then: npx wrangler secret put CF_API_TOKEN -c workers/edge-jwks-sync/wrangler.jsonc
```

Run with `"action": "log"`, check **Security > Events**, then switch to `"block"` and run again. A
blocked request gets 401 with a JSON body from the edge. Per-host settings: `audience` (the echo MCP
app, or the agent's blueprint for the interactive agent), `requireAgent`, `allowedBlueprints`,
`publicPaths` (`/`, `/healthz`). `/.well-known/*` and CORS preflights are always exempt.

## Agents SDK routing hooks

If you route with `routeAgentRequest()` (needed for the Agents SDK's WebSocket clients), its
`onBeforeConnect` and `onBeforeRequest` hooks are the place to validate the Entra token: return a
`Response` to reject, or a new `Request` (for example with a header the Agent trusts) to continue.
Check that the instance name in the URL is the one the token allows (for example the user's `oid`).
Browsers cannot set `Authorization` on a WebSocket upgrade, so read the token from a query
parameter or cookie there. `props` reach an Agent only when the request starts it.

This sample validates in the Worker and then calls the Agent over RPC with `getAgentByName(oid)`,
which gives the same guarantee without URL-based routing.

## What does not fit, and why

| Feature | Why not for Entra Agent ID calls |
|---|---|
| Access **Managed OAuth** (Access as the OAuth server for MCP clients) | Access issues opaque Access tokens after a browser sign-in; the agent identity is not in them and OBO is impossible. Good for people using MCP clients. |
| Access **Linked App Token** | Accepts only tokens that Access itself issued. |
| **MCP server portals** (GA Sep 2026) | Clients authenticate with Access (sign-in or service token); toward upstream servers the portal uses its own OAuth, a static bearer or nothing, with no pass-through of the caller's token. A governance layer for people, not for agent tokens. |
| Access **service tokens**, **mTLS** | Static Cloudflare credentials. They can admit traffic, but say nothing about which agent or user is calling. |
| `OAuthProvider` / `resolveExternalToken` | The combined provider needs KV and its own authorize/token endpoints; the resource-server role (`OAuthResourceServer`) is the right fit and is what the sample uses. |
| Web Bot Auth, signed agents | Self-managed keys to identify bots to websites; not accepted by Entra. Cloudflare's November 2026 "trusted agent delegation" work is standards activity, not a token you can use today. |
| AI Gateway authentication | Protects the gateway with Cloudflare API tokens; it is not an Entra validator. |

## Not available yet

* **A workload identity token for Workers.** Cloudflare's April 2026 sandbox-auth post says
  platforms "will need to roll their own" token exchange; the August 2026 "Agent Access Model" post
  is a reference architecture. Until that changes, the blueprint holds a certificate.
* **Non-extractable keys.** The Workers API has a `secret_key` binding that exposes uploaded key
  material as a non-extractable `CryptoKey`; it is not in the bindings documentation or Wrangler
  configuration yet. If it becomes generally available, it is the natural home for the blueprint
  key (code could sign but never read it). Not used here.

## References

* Access on Workers, `ctx.access`: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
* Validate Access JWTs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
* API Shield JWT validation: https://developers.cloudflare.com/api-shield/security/jwt-validation/ (API: `/api/`, key sync Worker: `/jwt-worker/`)
* `OAuthResourceServer`: https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md
* `createMcpHandler`: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
* MCP authorization on Cloudflare: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
* Agents SDK routing authentication: https://developers.cloudflare.com/agents/runtime/routing/authentication/
* Service bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
* Rate Limiting binding (GA): https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/
* MCP server portals: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
* Secure MCP servers with Access: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
* Compatibility flags (`global_fetch_strictly_public`): https://developers.cloudflare.com/workers/configuration/compatibility-flags/
* Cloudflare blog: https://blog.cloudflare.com/sandbox-auth/, https://blog.cloudflare.com/the-agent-access-model/, https://blog.cloudflare.com/trusted-agent-delegation/
