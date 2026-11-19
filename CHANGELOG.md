# Changelog

## 2026-11-19

**Interactive agent**

* A second MCP server: the echo MCP server next to Microsoft MCP Server for Enterprise, with one
  on-behalf-of token per server and the tools of both offered together (`ECHO_MCP_URL`,
  `ECHO_MCP_SCOPES`, the `ECHO_MCP_SERVICE` binding). A server that fails is reported on its own; the
  other keeps working.
* Calls through a service binding send the `Host` header of the server URL, which
  `createMcpHandler` requires on workers.dev endpoints.
* Chat: conversation memory that ends after `CHAT_MEMORY_MINUTES` (default 30) and `chat --new`;
  repeated identical tool calls run once; every tool result restates the latest question; an
  unreachable server is named in the system prompt with its reason; a first reply without a tool call
  is asked once more; tool calls written as text are run; a final reply that is only another call is
  replaced by the last tool result; temperature 0.2 and up to 1,024 output tokens per model call.
* The model sees the echo server's tools as `echo_server_whoami` and `echo_server_echo`; tools without
  parameters are offered with a plain empty schema.
* `chat --debug` (`"debug": true`) returns one trace entry per model call; `chat --model <id>`
  (`"model"`) picks a model from `AI_MODEL_CHOICES` for one request.
* CLI: `call --server` and `--arg key=value`; tools grouped by server; failed tool calls show their
  reason.

**Echo MCP server**

* Accepts service binding calls without a `Host` header by giving them the host of their URL; a
  `Host` that is present is still checked.
* Clearer tool descriptions, and a 403 message that explains missing Agent ID claims.

**Entra setup**

* The echo app registration gets the Agent ID optional claims for its access tokens
  (`xms_par_app_azp`, `xms_act_fct`, `xms_sub_fct`, `xms_tnt_fct`, and `idtyp` with
  `include_user_token`); optional claims already there are kept.

**Documentation**

* README and guides rewritten for the current state, including what is confirmed live.

## 2026-11-18

* `@cloudflare/workers-types` asks for `^5.20260703.1` (version 5 replaced 4.x on 3 July 2026).
* `npm run check:feed` lists every package an npm mirror cannot serve, in one run.
* The guides say where to run each command (always the project root) and where files go.

## 2026-11-11

* The autonomous agent runs only when an operator starts it (`npm run autonomous:run`,
  `npm run autonomous:status`); a schedule is optional. A second start while a run is in progress gets 409.
* Cost and Free plan notes in the deployment guide.

## 2026-11-10

* First version: the interactive and autonomous agents with MSAL Node and certificate-based
  blueprints, the echo MCP server (Cloudflare-native and dependency-free editions), the optional edge
  authorizer (API Shield JWT validation), Cloudflare Access for operators, and the Entra setup script.
