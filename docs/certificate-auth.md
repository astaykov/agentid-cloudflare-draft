# Certificate authentication for the agent identity blueprint

Cloudflare Workers have no platform-issued workload identity token: the runtime cannot present an
OIDC token of its own, and there is no managed identity. The secretless pattern, a federated
identity credential on the blueprint that trusts the platform's token, therefore has no equivalent
here. This sample uses the documented fallback: **a certificate on the blueprint**.

Microsoft's guidance in one table:

| Credential on the blueprint | Microsoft Learn says | Fits Cloudflare? |
|---|---|---|
| Managed identity as FIC | Recommended for production | No (no Azure managed identity on Workers) |
| Other FIC (another cloud's workload identity, GitHub, Kubernetes, any OIDC issuer) | Supported | Only with a self-hosted OIDC issuer (not covered here) |
| **Certificate** | "Use a certificate when the platform can't project an OIDC token" (Auth SDK configuration); client certificates listed as a secure alternative to secrets | **Yes: this sample** |
| Client secret | Not for production; cannot satisfy the SN+I requirement for FMI | No |

The create-blueprint page also says key credentials are "supported, but not recommended for
production" compared with a managed identity. On a platform without managed identity, a
certificate is the strongest documented option.

## How the Worker signs in

```text
BLUEPRINT_CERT_PEM + BLUEPRINT_KEY_PEM  (Worker secrets or Secrets Store)
        |
        v
loadBlueprintCertificate()       parse PEM, import key into WebCrypto as NON-EXTRACTABLE,
        |                        compute x5t#S256 / x5t, read validity, prove key matches cert
        v
createClientAssertion()          PS256 JWT with x5t#S256 and x5c (MSAL's format)
        |
        v
MSAL Node clientAssertion callback  -> Leg 1 token request with fmi_path
```

Why not MSAL's built-in `clientCertificate` option? It produces the same JWT, but it signs
through `jsonwebtoken` and `node:crypto` key objects. On Workers, `node:crypto` is largely
implemented, yet workerd currently rejects a `KeyObject` passed inside an options object
(cloudflare/workerd#7772, October 2026), which is the shape RSA-PSS signing uses. The
`clientAssertion` callback is MSAL's documented extension point, keeps MSAL in charge of the
protocol and the cache, and lets the native WebCrypto implementation do the signing.

If you want to try MSAL's own signing, replace the blueprint client's `auth` with:

```ts
auth: {
  clientId: BLUEPRINT_CLIENT_ID,
  authority,
  clientCertificate: {
    thumbprintSha256: "<hex SHA-256 thumbprint>",
    privateKey: keyPem,
    x5c: certPem, // sends the x5c chain (SN+I), required for FMI
  },
},
```

## The assertion format

| Field | Value | Source |
|---|---|---|
| `alg` | `PS256` (default) or `RS256` (`ASSERTION_ALGORITHM`) | Learn: certificate credentials ("should be PS256") |
| `x5t#S256` / `x5t` | Base64url SHA-256 (PS256) or SHA-1 (RS256) thumbprint of the DER certificate | Learn; MSAL behaviour |
| `x5c` | Base64 DER certificate chain, leaf first | MSAL agentic guide: required for FMI (SN+I) |
| `aud` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | Learn |
| `iss`, `sub` | Blueprint app ID | Learn |
| `jti`, `nbf`, `iat`, `exp` | Fresh GUID; `exp` = `nbf` + 10 minutes | Learn (5 to 10 minutes), MSAL |

`test/certificate.test.ts` checks this shape and verifies both signature types with Node's
crypto, for a certificate produced by the generator below.

### About SN+I and `x5c`

The MSAL guide for agentic scenarios states the blueprint "must use Subject Name + Issuer
(SN+I) authentication for FMI flows" and that Entra rejects Leg 1 otherwise; every MSAL
language does this by sending the `x5c` chain. This sample always sends it. Learn's
certificate-credentials page does not mention `x5c`. In a customer tenant, the certificate is
also uploaded to the blueprint (`keyCredentials`), so Entra can match it by thumbprint.
If Leg 1 fails while the plain blueprint sign-in works, check this first.

## Creating the certificate

Pick one:

1. **Generator in this repo (dev/test, zero dependencies)**, run from the project root (the folder
   with `package.json`):
   ```bash
   npm run cert:interactive      # = node scripts/cert/new-blueprint-cert.mjs --name interactive-blueprint (RSA 2048, 12 months)
   npm run cert:autonomous       # = ... --name autonomous-blueprint
   node scripts/cert/new-blueprint-cert.mjs --name autonomous-blueprint --key-size 3072   # other options: --months, --cn, --out, --force
   ```
   Writes the PEM certificate, PKCS#8 key, DER `.cer`, a Graph `keyCredentials` body and a
   `.dev.vars` snippet to `certs/<name>/` in the project root, where `entra.config.json` and the
   deployment guide expect them, and prints the matching `wrangler secret put` commands (PowerShell
   form on Windows).
2. **OpenSSL** (ships with Git for Windows)
   ```bash
   openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
     -subj "/CN=interactive-blueprint" -keyout key.pem -out cert.pem
   openssl x509 -in cert.pem -outform der -out cert.cer
   ```
3. **Azure Key Vault or your enterprise PKI** (recommended for production). Microsoft's
   general guidance is to avoid self-signed certificates in production and use a CA-issued
   certificate. The Worker needs the private key as PEM, so the key must be exportable;
   keep the exported copy only as long as it takes to store it in Cloudflare.

Entra limits a certificate credential's end date to one year after its start date; the
generator therefore caps validity at 12 months.

## Storing the key on Cloudflare

| Option | Scope | Notes |
|---|---|---|
| **Worker secrets** (default) | One Worker | `wrangler secret put`; encrypted at rest; max 5 KB per value (an RSA 4096 key fits) |
| **Secrets Store** | Account | Open beta; central rotation; bind with `secrets_store_secrets` and the code calls `await env.X.get()` (supported: `BLUEPRINT_*_PEM` may be either form) |

Secrets Store binding example:

```jsonc
"secrets_store_secrets": [
  { "binding": "BLUEPRINT_KEY_PEM",  "store_id": "<store id>", "secret_name": "interactive-blueprint-key" },
  { "binding": "BLUEPRINT_CERT_PEM", "store_id": "<store id>", "secret_name": "interactive-blueprint-cert" }
]
```

Inside the Worker the key is imported as a **non-extractable** `CryptoKey`. That protects
against accidental logging of the key object, not against code that reads the secret string:
anyone who can deploy code to the Worker can read its secrets.

## Isolation: one blueprint per Worker

Whoever holds a blueprint credential can obtain T1 for **every** agent identity created from
that blueprint. Give each Worker (trust boundary) its own blueprint and certificate, as the
sample does: the interactive and autonomous Workers never share a key. Durable Object
instances inside a Worker (one per user, one per job) share the Worker's identity; they
scope state, not credentials.

## Rotation without downtime

1. Create the new certificate.
2. Add it to the blueprint **next to** the current one: Entra admin center
   (Agent ID > the blueprint > Certificates & secrets) or Graph `addKey`
   (`POST /applications/{id}/microsoft.graph.agentIdentityBlueprint/addKey`, which needs a
   proof JWT signed with the current certificate). Do not `PATCH keyCredentials` with only the
   new certificate: a PATCH replaces the whole collection.
3. Update both Worker secrets. `wrangler secret put` deploys a new version right away.
4. Check `GET /healthz` (new thumbprint) and run a request.
5. Remove the old certificate from the blueprint.

## Hardening checklist

* Keep Cloudflare account membership and API tokens with "Workers Scripts: Edit" tight: they
  can read the key.
* Separate Cloudflare accounts (or at least Workers) per environment and per blueprint.
* Short certificate lifetimes, monitored expiry (`/healthz` reports days left).
* Watch the blueprint's sign-ins in Entra (service principal sign-in logs).
* Grant agent identities only the scopes they need; for OBO the user's own permissions still
  apply on top.
* Never log tokens; the sample logs only AADSTS codes and correlation IDs.
