# Microsoft Entra setup

Everything here is created with Microsoft Graph **v1.0**. You can run the zero-dependency
script (Option A) or send the requests yourself, for example from Graph Explorer (Option B).

## What gets created

| Object | Entra type | Interactive | Autonomous | Purpose |
|---|---|---|---|---|
| Blueprint + blueprint principal | `agentIdentityBlueprint` / `agentIdentityBlueprintPrincipal` | yes | yes | Holds the **certificate**. One per Worker. |
| Agent identity | `agentIdentity` | yes | yes | The identity the agent runs as. Its app ID equals its object ID. |
| Exposed API `access_agent` | on the interactive blueprint | yes | | Users get tokens with `aud` = blueprint |
| CLI client app | app registration (public client) | yes | | Signs users in for testing |
| Agent user | `agentUser` | | `agent-user` mode | The agent's own user account for delegated-only resources |
| MCP Server for Enterprise principal | service principal of `e8c77dc2-69b3-43f4-bc51-3213c9d915b4` | yes | yes | Provisioned once per tenant |
| Echo MCP app (optional) | app registration | optional | optional | Your own MCP server; shows claims; supports app-only |

## Prerequisites

* A test tenant where you are **Global Administrator**, or hold:
  * **Agent ID Administrator**: certificates on blueprints, agent identities, agent users;
  * **Cloud Application Administrator** (or Application Administrator): app registrations,
    service principals and delegated permission grants;
  * **Privileged Role Administrator**: only for the optional Directory Readers assignment and
    app role grants.
* For `AUTH_MODE=agent-user`: the tenant must be in the **Frontier** preview program
  (agent users). Without it, use the interactive scenario and the echo MCP server in
  `app-only` mode.
* Microsoft MCP Server for Enterprise is in **preview**, global cloud only.
* The two certificates from `npm run cert:interactive` and `npm run cert:autonomous`
  (see [certificate-auth.md](certificate-auth.md)).

## Option A: the setup script

From the project root (the folder with `package.json`):

```bash
cp scripts/entra/entra.config.example.json scripts/entra/entra.config.json
# edit tenantId, certificate paths, the agent user's UPN (verified domain), enable "echo" if wanted
npm run entra:setup:dry-run          # prints every Graph request, sends nothing
npm run entra:setup                  # signs you in (browser), then creates/updates the objects
```

* Sign-in uses the public client "Microsoft Graph Command Line Tools"
  (`14d82eec-204b-4c2f-b7e8-296a70dab67e`, the same app Microsoft Graph PowerShell uses) with
  authorization code + PKCE on a `localhost` redirect. `--device-code` switches to the device
  code flow. Or set `ENTRA_ACCESS_TOKEN` to a Graph token you obtained elsewhere (for example
  Graph Explorer) and the script skips sign-in.
* The script is idempotent: it records object IDs (no secrets) in
  `scripts/entra/.entra-state.json`, looks objects up before creating them, and retries the
  replication errors Entra returns right after a create.
* At the end it prints the values for each Worker's `wrangler.jsonc` and writes them to
  `scripts/entra/out/<tenant>.json`.
* It never adds a certificate to a blueprint that already has a different one (a PATCH would
  replace it); it prints the manual step and exits with code 2. Rotate as described in
  [certificate-auth.md](certificate-auth.md#rotation-without-downtime).
* Other options: `--only interactive,autonomous,echo` (run some sections), `--state <file>`,
  `--out <dir>`, `--verbose`, `--help`. Exit codes: 0 done, 1 error, 2 done but a manual step
  is needed.
* Delegated Graph permissions it requests: `User.Read`, `AgentIdentityBlueprint.Create`,
  `AgentIdentityBlueprint.AddRemoveCreds.All`, `AgentIdentityBlueprint.UpdateAuthProperties.All`,
  `AgentIdentityBlueprintPrincipal.Create`, `AgentIdentity.Create.All`,
  `Application.ReadWrite.All`, `DelegatedPermissionGrant.ReadWrite.All`; plus
  `AgentIdUser.ReadWrite.IdentityParentedBy` and `User.ReadBasic.All` for the agent user,
  `RoleManagement.ReadWrite.Directory` for Directory Readers, and
  `AppRoleAssignment.ReadWrite.All` for the echo app. The first sign-in shows a consent prompt
  for these (an administrator must consent).

## Option B: the Graph requests

All requests: `Authorization: Bearer <Graph token>`, `Content-Type: application/json`.
Microsoft's Agent ID how-tos also send `OData-Version: 4.0` on the Agent ID requests.
Right after a create, a dependent request can fail with "does not exist": wait a few seconds
and retry.

### Interactive scenario

**1. Your user ID** (sponsor and owner)

```http
GET https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName
```

**2. Blueprint** (`AgentIdentityBlueprint.Create`)

```http
POST https://graph.microsoft.com/v1.0/applications/microsoft.graph.agentIdentityBlueprint

{
  "displayName": "agentid-cf-interactive-blueprint",
  "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<your-user-id>"],
  "owners@odata.bind":   ["https://graph.microsoft.com/v1.0/users/<your-user-id>"]
}
```
Keep `id` (object ID) and `appId` (= `BLUEPRINT_CLIENT_ID`).

**3. Blueprint principal** (`AgentIdentityBlueprintPrincipal.Create`)

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal

{ "appId": "<blueprint appId>" }
```

**4. Certificate** (`AgentIdentityBlueprint.AddRemoveCreds.All`, Agent ID Administrator)

The generator wrote this body to `certs/interactive-blueprint/interactive-blueprint.keycredential.json`.

```http
PATCH https://graph.microsoft.com/v1.0/applications/<blueprint object id>/microsoft.graph.agentIdentityBlueprint

{
  "keyCredentials": [{
    "type": "AsymmetricX509Cert",
    "usage": "Verify",
    "key": "<Base64 of the DER .cer file>",
    "displayName": "CN=interactive-blueprint"
  }]
}
```
This replaces all key credentials. Or upload the `.cer` in the Entra admin center:
Agent ID > Agent blueprints > the blueprint > Certificates & secrets.

**5. Expose the API users will call** (`AgentIdentityBlueprint.UpdateAuthProperties.All`)

```http
PATCH https://graph.microsoft.com/v1.0/applications/<blueprint object id>

{
  "identifierUris": ["api://<blueprint appId>"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "<new GUID>",
      "value": "access_agent",
      "type": "User",
      "isEnabled": true,
      "adminConsentDisplayName": "Access agent",
      "adminConsentDescription": "Allow the application to access the agent on behalf of the signed-in user."
    }]
  }
}
```
`requestedAccessTokenVersion: 2` makes Entra issue v2.0 tokens whose `aud` is the blueprint
app ID; the Worker accepts only v2.0 tokens.

**6. Agent identity** (`AgentIdentity.Create.All`; blueprint owners need no extra role)

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentity

{
  "displayName": "agentid-cf-interactive-agent",
  "agentIdentityBlueprintId": "<blueprint appId>",
  "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<your-user-id>"]
}
```
`id` = `AGENT_IDENTITY_ID`.

**7. MCP Server for Enterprise in your tenant** (once per tenant)

```http
GET  https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq 'e8c77dc2-69b3-43f4-bc51-3213c9d915b4'&$select=id,appId,displayName
POST https://graph.microsoft.com/v1.0/servicePrincipals
{ "appId": "e8c77dc2-69b3-43f4-bc51-3213c9d915b4" }
```
(`Grant-EntraBetaMCPServerPermission -ApplicationName VisualStudioCode` from Microsoft's
get-started guide also provisions it, if you have the Microsoft.Entra.Beta module.)

**8. Delegated MCP scopes for the agent identity** (`DelegatedPermissionGrant.ReadWrite.All`)

Agent identities cannot be consented to interactively (`AADSTS82014`), so an admin grants them:

```http
POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants

{
  "clientId": "<agent identity id>",
  "consentType": "AllPrincipals",
  "resourceId": "<MCP server service principal id>",
  "scope": "MCP.User.Read.All MCP.GroupMember.Read.All"
}
```
List the available scopes with
`GET https://graph.microsoft.com/v1.0/servicePrincipals(appId='e8c77dc2-69b3-43f4-bc51-3213c9d915b4')/oauth2PermissionScopes`.
With OBO the user's own permissions still apply.

*Alternative:* grant the scopes to the **blueprint principal** and mark the MCP server as
inheritable, so every agent identity of that blueprint inherits them:

```http
POST https://graph.microsoft.com/v1.0/applications/<blueprint object id>/microsoft.graph.agentIdentityBlueprint/inheritablePermissions

{ "resourceAppId": "e8c77dc2-69b3-43f4-bc51-3213c9d915b4",
  "inheritableScopes": { "@odata.type": "microsoft.graph.enumeratedScopes", "scopes": ["MCP.User.Read.All", "MCP.GroupMember.Read.All"] } }
```

**9. CLI client app** (`Application.ReadWrite.All`)

```http
POST https://graph.microsoft.com/v1.0/applications

{
  "displayName": "agentid-cf-cli-client",
  "signInAudience": "AzureADMyOrg",
  "isFallbackPublicClient": true,
  "publicClient": { "redirectUris": ["http://localhost"] },
  "requiredResourceAccess": [{
    "resourceAppId": "<blueprint appId>",
    "resourceAccess": [{ "id": "<access_agent scope id>", "type": "Scope" }]
  }]
}
```
Then `POST /v1.0/servicePrincipals {"appId": "<client appId>"}` and grant it the scope so users
are not prompted:

```http
POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants

{ "clientId": "<client service principal id>", "consentType": "AllPrincipals",
  "resourceId": "<blueprint principal id>", "scope": "access_agent" }
```

### Autonomous scenario

**10.** Repeat steps 2, 3, 4 and 6 with `agentid-cf-autonomous-blueprint`,
`agentid-cf-autonomous-agent` and the autonomous certificate. No exposed API is needed.

**11. Agent user** (`AgentIdUser.ReadWrite.IdentityParentedBy`, Agent ID Administrator; Frontier tenants)

```http
POST https://graph.microsoft.com/v1.0/users/microsoft.graph.agentUser

{
  "accountEnabled": true,
  "displayName": "Cloudflare autonomous agent",
  "mailNickname": "agentid-cf-autonomous",
  "userPrincipalName": "agentid-cf-autonomous@<verified domain>",
  "identityParentId": "<autonomous agent identity id>"
}
```
One agent user per agent identity. It has no password and cannot hold privileged admin roles.

**12. Delegated MCP scopes for that agent user only**

```http
POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants

{
  "clientId": "<autonomous agent identity id>",
  "consentType": "Principal",
  "principalId": "<agent user id>",
  "resourceId": "<MCP server service principal id>",
  "scope": "MCP.User.Read.All MCP.GroupMember.Read.All"
}
```

**13. (Optional) Directory Readers for the agent user** (`RoleManagement.ReadWrite.Directory`)

Agent users have restricted default permissions. To let the autonomous agent count users and
groups, assign a read-only directory role:

```http
POST https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments

{ "principalId": "<agent user id>", "roleDefinitionId": "88d8e3e3-8f55-4a1e-953a-9b9898b8876b", "directoryScopeId": "/" }
```

### Echo MCP server (optional)

**14.** App registration with a delegated scope and an application role:

```http
POST https://graph.microsoft.com/v1.0/applications

{
  "displayName": "agentid-cf-echo-mcp",
  "signInAudience": "AzureADMyOrg",
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{ "id": "<GUID>", "value": "Echo.Read", "type": "User", "isEnabled": true,
      "adminConsentDisplayName": "Call the echo MCP server", "adminConsentDescription": "Allows the app to call the echo MCP server on behalf of the signed-in user." }]
  },
  "appRoles": [{ "id": "<GUID>", "value": "Echo.Read.All", "allowedMemberTypes": ["Application"], "isEnabled": true,
    "displayName": "Call the echo MCP server as an application", "description": "Allows an application or agent to call the echo MCP server with its own identity." }],
  "optionalClaims": {
    "accessToken": [
      { "name": "xms_par_app_azp", "source": null, "essential": false, "additionalProperties": [] },
      { "name": "xms_act_fct", "source": null, "essential": false, "additionalProperties": [] },
      { "name": "xms_sub_fct", "source": null, "essential": false, "additionalProperties": [] },
      { "name": "xms_tnt_fct", "source": null, "essential": false, "additionalProperties": [] },
      { "name": "idtyp", "source": null, "essential": false, "additionalProperties": ["include_user_token"] }
    ]
  }
}
```

**The Agent ID claims are optional claims of the resource.** Entra puts `xms_par_app_azp` (the
agent's blueprint), `xms_act_fct` and `xms_sub_fct` (11 = agent identity, 13 = agent user) and
`xms_tnt_fct` into an access token only when the app registration of the API the token is *for*
lists them under `optionalClaims.accessToken`. The agent and its blueprint need nothing for this;
the echo app does. Without them a token issued to an agent identity looks like any other app's
token and the echo server answers `403 access_denied` ("The token has no Agent ID claims").
`idtyp` with `include_user_token` adds `"idtyp": "user"` to delegated tokens (by default only
app-only tokens carry `idtyp`). `npm run entra:setup` adds all five and keeps optional claims that
are already there. By hand: Microsoft Entra admin center > App registrations >
`agentid-cf-echo-mcp` > **Manifest**, put the `accessToken` list above into `optionalClaims`, and
save. Do the same for any API of your own that wants to recognise agents.

Then set `identifierUris` to `["api://<echo appId>"]`, create its service principal, and grant:

* interactive agent identity: `oauth2PermissionGrant` (AllPrincipals) for `Echo.Read`;
* autonomous agent identity, app-only:

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals/<autonomous agent identity id>/appRoleAssignments

{ "principalId": "<autonomous agent identity id>", "resourceId": "<echo service principal id>", "appRoleId": "<Echo.Read.All role id>" }
```

* autonomous agent user (agent-user mode): `oauth2PermissionGrant` (Principal, `principalId` = the agent user) for `Echo.Read`.

The echo MCP server holds no credential: it only validates tokens issued for `api://<echo appId>`.
To accept only this sample's agents, set its `ALLOWED_BLUEPRINT_IDS` to the two blueprint app IDs
(the setup script prints this value). See [echo-mcp-server.md](echo-mcp-server.md).

## Verify

```http
GET https://graph.microsoft.com/v1.0/applications/<blueprint object id>?$select=appId,identifierUris,api,keyCredentials
GET https://graph.microsoft.com/v1.0/servicePrincipals/<agent identity id>
GET https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq '<agent identity id>'
```
Then deploy the Workers and run `npm run cli -- whoami` (see the deployment guide). With the echo
server configured, `tokens.leg2_on_behalf_of.echo` must show `xms_par_app_azp` (the interactive
blueprint) and `xms_act_fct`; if it does not, the echo app is missing the optional claims above.

## Values for the Workers

| Variable | Interactive | Autonomous |
|---|---|---|
| `TENANT_ID` | tenant | tenant |
| `BLUEPRINT_CLIENT_ID` | interactive blueprint `appId` | autonomous blueprint `appId` |
| `AGENT_IDENTITY_ID` | interactive agent identity `id` | autonomous agent identity `id` |
| `INBOUND_REQUIRED_SCOPES` | `access_agent` | |
| `AGENT_USER_UPN` / `AGENT_USER_ID` | | agent user |
| `MCP_SCOPES` | `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default` | same (agent-user) or `api://<echo appId>/.default` (app-only, echo server) |
| `ECHO_MCP_URL` / `ECHO_MCP_SCOPES` | echo server `/mcp` URL and `api://<echo appId>/Echo.Read` (optional second MCP server) | |

Echo MCP server: `TENANT_ID`, `ECHO_APP_ID` = echo `appId`, `ALLOWED_BLUEPRINT_IDS` = both blueprint `appId`s.

## Notes

* **Agent identities created by the blueprint itself.** From November 2026 Entra no longer
  grants `AgentIdentity.CreateAsManager` to blueprint principals automatically (message center
  MC1506728). This sample creates agent identities administratively, so it is not affected.
  If you want the Worker to create agent identities at runtime, an admin must grant that
  application permission first.
* **Quotas.** The Agent ID FAQ caps non-Microsoft platforms using app-only permissions at 250
  agent identities per blueprint.
* **Sponsors** can be users or Microsoft 365 / dynamic groups, not security groups.
