# Which MSAL can run on Cloudflare, and how this sample uses MSAL Node

The constraint for this sample: **no sidecar container, MSAL in-process**. On Cloudflare that
narrows the choice quickly.

| MSAL flavour | In a Worker? | Notes | Verdict |
|---|---|---|---|
| **MSAL Node** (JavaScript/TypeScript) | **Yes** | Runs in workerd with Node.js compatibility (on by default for compatibility dates from 2026-08-04). The agentic APIs (`fmiPath`, `acquireTokenByUserFederatedIdentityCredential`) need 5.3.0+. | **Used here** |
| MSAL Python | Python Workers are GA (September 2026, Pyodide) | MSAL Python's HTTP layer is synchronous (`requests`); Cloudflare documents async HTTP clients (aiohttp, httpx, `fetch` via FFI) for Python Workers. A custom synchronous `http_client` bridge would be needed. There is no Python Agents SDK (Durable Objects are available). Not verified. | Possible later |
| MSAL .NET / Microsoft.Identity.Web | No .NET runtime in Workers | Would need Cloudflare Containers | Outside the "no container" constraint |
| MSAL Java | No JVM in Workers | Containers | Outside the constraint |
| MSAL Go | Not practical (Go to Wasm; MSAL Go relies on `net/http` and `crypto/x509`) | Containers | Outside the constraint |
| Entra Auth SDK sidecar | Container | Explicitly excluded | No |

## From the MSAL guide's Node.js example to a Worker

The MSAL wiki page *How to Use FIC and FMI in Agentic Scenarios* has a complete Node.js
`AgentTokenService`. This sample keeps its structure (one blueprint client holding the
certificate, one agent client whose credential is a callback returning T1) and changes four
things for Workers:

| MSAL guide (Node.js) | This sample | Why |
|---|---|---|
| `clientCertificate: { thumbprintSha256, privateKey, x5c }` | `clientAssertion` callback; the JWT is signed with WebCrypto (`client-assertion.ts`) | Same JWT; avoids `jsonwebtoken` + `node:crypto` `KeyObject` options that workerd currently rejects (workerd#7772) |
| `readFileSync("/path/to/cert.pem")` | Worker secrets or Secrets Store (`BLUEPRINT_CERT_PEM`, `BLUEPRINT_KEY_PEM`) | No persistent file system in Workers |
| Default HTTP client | `system.networkClient = new FetchNetworkClient()` | Native `fetch` with explicit timeouts |
| CCA created once at application start-up | Created once per isolate (`token-service-factory.ts`) | Worker isolates come and go; the MSAL cache lives as long as the isolate |

Unchanged:

```ts
// Leg 1, inside the agent client's assertion callback
await blueprintCca.acquireTokenByClientCredential({ scopes: ["api://AzureADTokenExchange/.default"], fmiPath: agentId });
// app-only
await agentCca.acquireTokenByClientCredential({ scopes: [resource + "/.default"] });
// agent user
const t2 = await agentCca.acquireTokenByClientCredential({ scopes: ["api://AzureADTokenExchange/.default"] });
await agentCca.acquireTokenByUserFederatedIdentityCredential({ scopes, assertion: t2.accessToken, username });
```

Added (the MSAL guide covers app-only and agent users; on-behalf-of follows the Agent ID
on-behalf-of documentation):

```ts
await agentCca.acquireTokenOnBehalfOf({ oboAssertion: userTokenForBlueprint, scopes });
```

## Token cache on Workers

* MSAL keeps its cache in memory. In this sample that is per isolate: T1 and app tokens are
  reused across requests and users; OBO tokens are reused per user assertion.
* After an isolate is evicted, the next request does the exchange again (two token requests for
  OBO). That is acceptable for a sample.
* To persist the cache you could implement MSAL's `ICachePlugin` on Durable Object storage. The
  sample deliberately does not: it would store refresh tokens at rest.

## What MSAL Node needs from the runtime

From the msal-node source (v5.6.0 and v7.2.1): it imports `crypto` / `node:crypto` (hashing,
GUIDs, PKCE), `http` (only for the interactive loopback client), `fs` and `path` (only for the
Azure Arc managed identity source), and `jsonwebtoken` (only for `clientCertificate`); it uses
`process.env`, `process.platform`, `Buffer` and the global `fetch`. Workers' Node.js
compatibility provides all of these modules, and none of the code paths this sample uses
touches `http`, `fs` or `jsonwebtoken` at run time.

Behaviour that matters here (msal-node source and changelog):

* `acquireTokenByClientCredential` checks the cache first, and `fmiPath` is part of the cache
  key (`fmi_path`), so T1 is cached per agent identity.
* The `clientAssertion` callback receives `{ clientId, tokenEndpoint, fmiPath }`
  (`tokenEndpoint` is correct from 5.3.0).
* `acquireTokenByUserFederatedIdentityCredential` always calls Entra; use
  `acquireTokenSilent` with the returned account afterwards (the sample does).
* `acquireTokenOnBehalfOf` looks up its cache by a hash of the incoming user token.
* A custom `system.networkClient` replaces the default `fetch`-based `HttpClient`.

## Version notes

* `fmiPath` and `acquireTokenByUserFederatedIdentityCredential` arrived in **5.3.0**
  (June 2026). The latest release is **7.2.1** (November 2026); 6.0 and 7.0 only changed
  interactive sign-in. Use 7.1.0 or later.
* MSAL Node 5.x replaced its HTTP client with `fetch` and removed `proxyUrl` /
  `customAgentOptions`; a custom `networkClient` is still supported.
* No official MSAL statement covers Cloudflare Workers either way (the MSAL team has an open
  request for Deno and one to move from `jsonwebtoken` to `jose`). This sample ran MSAL Node 7.x on
  Workers against a live tenant in November 2026: Leg 1 with the certificate and `fmiPath`, and
  on-behalf-of. Verify the app-only and agent-user flows in your own account.
