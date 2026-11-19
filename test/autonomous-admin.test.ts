/** The operator command for the autonomous agent, against a local stand-in of the Worker. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { authHeaders, explainFailure, main } from "../scripts/client/autonomous-admin.mjs";

const record = {
  trigger: "manual (access:operator@contoso.com)",
  startedAt: "2026-11-11T09:00:00.000Z",
  finishedAt: "2026-11-11T09:00:04.500Z",
  mode: "agent-user",
  ok: true,
  token: { aud: "e8c77dc2-69b3-43f4-bc51-3213c9d915b4", azp: "agent-id", upn: "agent@contoso.com", scp: "MCP.User.Read.All", xms_sub_fct: "13" },
  tools: ["microsoft_graph_suggest_queries", "microsoft_graph_get"],
  toolCalls: [{ tool: "microsoft_graph_get", arguments: { relativeUrl: "/users/$count" }, ok: true }],
  answer: "There are 42 users.",
};

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function capture() {
  const lines: string[] = [];
  return { lines, out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERR ${s}`) } };
}

test("credentials: admin key, then Access service token, then Access sign-in token", () => {
  assert.deepEqual(authHeaders({ AUTONOMOUS_ADMIN_KEY: "k", CF_ACCESS_TOKEN: "t" }).headers, { "x-admin-key": "k" });
  assert.deepEqual(authHeaders({ CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" }).headers, { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "s" });
  assert.deepEqual(authHeaders({ CF_ACCESS_TOKEN: "t" }).headers, { "cf-access-token": "t" });
  assert.deepEqual(authHeaders({}, "flag").headers, { "cf-access-token": "flag" });
  assert.equal(authHeaders({}).via, "none");
});

test("run: POST /run with the admin key, prints claims, tool calls and the answer", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/run");
    assert.equal(req.headers["x-admin-key"], "s3cret");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(record));
  }, async (url) => {
    const { lines, out } = capture();
    const code = await main(["run", "--url", url], { AUTONOMOUS_ADMIN_KEY: "s3cret" }, out);
    assert.equal(code, 0);
    const text = lines.join("\n");
    assert.match(text, /OK +2026-11-11T09:00:00.000Z  manual \(access:operator@contoso.com\)  mode=agent-user  4.5s/);
    assert.match(text, /azp=agent-id subject=agent@contoso.com scp=MCP.User.Read.All/);
    assert.match(text, /xms_sub_fct="13"/);
    assert.match(text, /answer: There are 42 users./);
  });
});

test("run: a run already in progress is reported (409)", async () => {
  await withServer((_req, res) => {
    res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ ...record, ok: false, error: { type: "already_running", message: "A run started at 09:00 (manual) is still in progress" } }));
  }, async (url) => {
    const { lines, out } = capture();
    assert.equal(await main(["run", "--url", url], { AUTONOMOUS_ADMIN_KEY: "k" }, out), 1);
    assert.match(lines.join("\n"), /still in progress/);
  });
});

test("status: GET /status with an Access service token lists the last runs", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers["cf-access-client-id"], "id");
    assert.equal(req.headers["cf-access-client-secret"], "secret");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runs: [record, { ...record, ok: false, error: { type: "token_acquisition_failed", aadsts: "AADSTS700016" } }] }));
  }, async (url) => {
    const { lines, out } = capture();
    assert.equal(await main(["status", "--url", url, "--last", "2"], { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" }, out), 0);
    const text = lines.join("\n");
    assert.match(text, /^OK /m);
    assert.match(text, /^FAILED /m);
    assert.match(text, /AADSTS700016/);
  });
});

test("Access sign-in redirect and disabled endpoints are explained", async () => {
  await withServer((req, res) => {
    if (req.url === "/status") res.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }).end();
    else res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
  }, async (url) => {
    const first = capture();
    assert.equal(await main(["status", "--url", url], {}, first.out), 1);
    assert.match(first.lines.join("\n"), /cloudflared access login/);
    const second = capture();
    assert.equal(await main(["run", "--url", url], { AUTONOMOUS_ADMIN_KEY: "k" }, second.out), 1);
    assert.match(second.lines.join("\n"), /admin endpoints are off/);
  });
  assert.match(explainFailure(403, { error: "access_required" }, "u", "x"), /ADMIN_AUTH=access/);
});
