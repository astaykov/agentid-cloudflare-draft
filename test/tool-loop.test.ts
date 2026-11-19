import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callKey,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  parseModelOutput,
  runToolLoop,
  toModelTool,
  toolCallsFromText,
  uniqueCalls,
  type AiBinding,
} from "../src/shared/agent/tool-loop.ts";

const tools = [
  { name: "microsoft_graph_suggest_queries", description: "suggest", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "microsoft_graph_get", description: "get", inputSchema: { $schema: "x", type: "object", properties: { relativeUrl: { type: "string" } } } },
];

test("parses Workers AI and OpenAI-style outputs", () => {
  assert.deepEqual(parseModelOutput({ response: "hi" }), { text: "hi", toolCalls: [] });
  assert.deepEqual(parseModelOutput({ response: null, tool_calls: [{ name: "a", arguments: { x: 1 } }] }).toolCalls, [{ name: "a", arguments: { x: 1 } }]);
  assert.deepEqual(
    parseModelOutput({ choices: [{ message: { content: null, tool_calls: [{ id: "1", type: "function", function: { name: "b", arguments: '{"y":2}' } }] } }] }).toolCalls,
    [{ name: "b", arguments: { y: 2 } }],
  );
});

test("runs suggest -> get -> answer and never shows the model a token", async () => {
  const seen: unknown[] = [];
  let call = 0;
  const ai: AiBinding = {
    async run(_model, inputs) {
      seen.push(inputs);
      call++;
      if (call === 1) return { tool_calls: [{ name: "microsoft_graph_suggest_queries", arguments: { q: "count users" } }] };
      if (call === 2) return { tool_calls: [{ name: "microsoft_graph_get", arguments: { relativeUrl: "/users/$count" } }] };
      return { response: "There are 42 users." };
    },
  };
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai,
    model: "@cf/test",
    systemPrompt: "sys",
    prompt: "How many users?",
    tools,
    callTool: async (name, args) => {
      invoked.push(`${name}:${JSON.stringify(args)}`);
      return name === "microsoft_graph_get" ? "42" : "GET /users/$count";
    },
  });
  assert.equal(result.answer, "There are 42 users.");
  assert.deepEqual(invoked, ['microsoft_graph_suggest_queries:{"q":"count users"}', 'microsoft_graph_get:{"relativeUrl":"/users/$count"}']);
  assert.equal(result.toolCalls.length, 2);
  // tools were offered with $schema stripped
  const firstTools = (seen[0] as any).tools;
  assert.equal(firstTools[1].parameters.$schema, undefined);
  assert.ok(!JSON.stringify(seen).includes("eyJ"), "no JWT-looking strings in prompts");
});

test("unknown tools and tool errors are reported back, last step has no tools", async () => {
  let call = 0;
  const ai: AiBinding = {
    async run(_m, inputs) {
      call++;
      if ((inputs as any).tools) return { tool_calls: [{ name: call === 1 ? "nope" : "microsoft_graph_get", arguments: {} }] };
      return { response: "done" };
    },
  };
  const result = await runToolLoop({
    ai, model: "m", systemPrompt: "s", prompt: "p", tools, maxSteps: 3,
    callTool: async () => { throw new Error("403 Forbidden"); },
  });
  assert.equal(result.answer, "done");
  assert.equal(result.steps, 3);
  assert.deepEqual(result.toolCalls.map((c) => [c.tool, c.ok]), [["nope", false], ["microsoft_graph_get", false]]);
  assert.match(result.toolCalls[1].preview, /403/);
});

test("the same tool with the same arguments is the same call, whatever the key order", () => {
  assert.equal(callKey("get", { url: "/users", headers: { a: 1, b: 2 } }), callKey("get", { headers: { b: 2, a: 1 }, url: "/users" }));
  assert.notEqual(callKey("get", { url: "/users" }), callKey("get", { url: "/groups" }));
  assert.notEqual(callKey("get", { url: "/users" }), callKey("list", { url: "/users" }));
  const calls = [
    { name: "get", arguments: { url: "/users" } },
    { name: "get", arguments: { url: "/users" } },
    { name: "get", arguments: { url: "/groups" } },
  ];
  assert.deepEqual(uniqueCalls(calls).map((c) => c.arguments.url), ["/users", "/groups"]);
});

test("a call the model repeats runs once; a step with nothing new makes the model answer", async () => {
  const seen: any[] = [];
  let call = 0;
  const ai: AiBinding = {
    async run(_m, inputs) {
      seen.push(JSON.parse(JSON.stringify(inputs)));
      call++;
      const get = { name: "microsoft_graph_get", arguments: { relativeUrl: "/users", headers: { a: 1, b: 2 } } };
      if (call === 1) return { tool_calls: [get, { name: "microsoft_graph_get", arguments: { headers: { b: 2, a: 1 }, relativeUrl: "/users" } }] };
      if (call === 2) return { tool_calls: [get] };
      return { response: "There are 3 users." };
    },
  };
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai, model: "m", systemPrompt: "s", prompt: "How many users?", tools,
    callTool: async (name) => { invoked.push(name); return "3"; },
  });
  assert.deepEqual(invoked, ["microsoft_graph_get"], "four requests from the model, one call to the server");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.answer, "There are 3 users.");
  assert.equal(result.completed, true);
  assert.equal(result.steps, 3);
  assert.equal(seen[2].tools, undefined, "after a step with nothing new the model gets no tools");
  const last = seen[2].messages.at(-1).content as string;
  assert.match(last, /already called in this turn/);
  assert.match(last, /Do not call more tools/);
});

test("tool results restate the latest question, so an earlier one in the history is not answered again", async () => {
  const seen: any[] = [];
  let call = 0;
  const ai: AiBinding = {
    async run(_m, inputs) {
      seen.push(JSON.parse(JSON.stringify(inputs)));
      call++;
      if (call === 1) return { tool_calls: [{ name: "echo_api", arguments: { data: "who is calling" } }] };
      return { response: "The echo MCP server is not available." };
    },
  };
  const history = [
    { role: "user" as const, content: "How many guest users are in my tenant?" },
    { role: "assistant" as const, content: "There are 4 guest users." },
  ];
  const result = await runToolLoop({
    ai, model: "m", systemPrompt: "s", prompt: "Ask the echo server who is calling it", history, tools,
    callTool: async () => "unused",
  });
  assert.equal(seen[0].messages[1].content, "How many guest users are in my tenant?", "the history comes before the new question");
  assert.equal(seen[0].messages.at(-1).content, "Ask the echo server who is calling it");
  const followUp = seen[1].messages.at(-1).content as string;
  assert.match(followUp, /Unknown tool 'echo_api'\. The only tools are: microsoft_graph_suggest_queries, microsoft_graph_get\. Do not guess tool names/);
  assert.match(followUp, /My latest question: "Ask the echo server who is calling it"/);
  assert.doesNotMatch(followUp, /original question/);
  assert.deepEqual(result.toolCalls.map((c) => [c.tool, c.ok]), [["echo_api", false]]);
  assert.equal(result.completed, true);
});

test("a turn without a final answer is not completed", async () => {
  const ai: AiBinding = { async run() { return { response: "   " }; } };
  const result = await runToolLoop({ ai, model: "m", systemPrompt: "s", prompt: "p", tools, callTool: async () => "x" });
  assert.equal(result.completed, false);
  assert.equal(result.answer, "(the model returned no text)");
});

const echoTools = [
  ...tools,
  { name: "whoami", description: "[echo MCP server] Returns the caller's identity", inputSchema: { type: "object", properties: {} } },
  { name: "echo", description: "[echo MCP server] Echoes a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
];

test("a first reply that calls no tool is asked once more, and the retry calls the tool (seen live)", async () => {
  const seen: any[] = [];
  let call = 0;
  const ai: AiBinding = {
    async run(_m, inputs) {
      seen.push(JSON.parse(JSON.stringify(inputs)));
      call++;
      if (call === 1) return { response: "Your input is incomplete. Please provide further details or specify the task you need help with." };
      if (call === 2) return { tool_calls: [{ name: "whoami", arguments: {} }] };
      return { response: "The echo server sees agent identity d0bf acting for Anton (agent-obo)." };
    },
  };
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai, model: "m", systemPrompt: "s", prompt: "Ask the echo server who is calling it", tools: echoTools,
    callTool: async (name) => { invoked.push(name); return '{"flow":"agent-obo"}'; },
  });
  assert.deepEqual(invoked, ["whoami"]);
  assert.equal(result.answer, "The echo server sees agent identity d0bf acting for Anton (agent-obo).");
  assert.equal(result.completed, true);
  assert.deepEqual(result.trace.map((t) => t.outcome), ["asked_again", "tool_calls", "answer"]);
  assert.match(result.trace[0].text ?? "", /Your input is incomplete/);
  assert.equal(seen[1].tools.length, echoTools.length, "the retry still offers every tool");
  const retry = seen[1].messages.slice(-2);
  assert.equal(retry[0].role, "assistant");
  assert.match(retry[1].content, /calling the tool that fits/);
  assert.match(retry[1].content, /Your tools: microsoft_graph_suggest_queries, microsoft_graph_get, whoami, echo\./);
  assert.match(retry[1].content, /A tool without parameters is called with empty arguments \{\}/);
  assert.match(retry[1].content, /My question: "Ask the echo server who is calling it"/);
});

test("a greeting is asked once more, then answered without a tool", async () => {
  let call = 0;
  const ai: AiBinding = { async run() { call++; return { response: call === 1 ? "Hello!" : "Hello! How can I help?" }; } };
  const result = await runToolLoop({ ai, model: "m", systemPrompt: "s", prompt: "hi", tools: echoTools, callTool: async () => "x" });
  assert.equal(result.answer, "Hello! How can I help?");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.steps, 2);
  assert.deepEqual(result.trace.map((t) => t.outcome), ["asked_again", "answer"]);
});

test("tool calls written as text are run like tool calls", async () => {
  for (const written of [
    '{"name": "whoami", "parameters": {}}',
    '<|python_tag|>{"type": "function", "name": "whoami", "parameters": {}}',
    '```json\n[{"name": "whoami", "arguments": "{}"}]\n```',
    "<function=whoami>{}</function>",
  ]) {
    let call = 0;
    const ai: AiBinding = { async run() { call++; return call === 1 ? { response: written } : { response: "agent-obo" }; } };
    const invoked: string[] = [];
    const result = await runToolLoop({ ai, model: "m", systemPrompt: "s", prompt: "who?", tools: echoTools, callTool: async (n) => { invoked.push(n); return "{}"; } });
    assert.deepEqual(invoked, ["whoami"], written);
    assert.equal(result.trace[0].toolCallsFromText, true, written);
    assert.equal(result.answer, "agent-obo", written);
  }
});

test("only offered tool names make text a tool call", () => {
  const names = new Set(["whoami", "echo"]);
  assert.deepEqual(toolCallsFromText('<function=echo>{"message":"hi"}</function>', names), [{ name: "echo", arguments: { message: "hi" } }]);
  assert.deepEqual(toolCallsFromText('{"function": {"name": "echo", "arguments": "{\\"message\\":\\"x\\"}"}}', names), [{ name: "echo", arguments: { message: "x" } }]);
  assert.deepEqual(toolCallsFromText('{"name": "Anton", "mail": "a@contoso.com"}', names), [], "an answer that is JSON with a name");
  assert.deepEqual(toolCallsFromText('[{"name": "whoami"}, {"name": "rm_rf"}]', names), [], "any unknown name: not a tool call");
  assert.deepEqual(toolCallsFromText("There are 4 guest users.", names), []);
  assert.deepEqual(toolCallsFromText("{not json", names), []);
  assert.deepEqual(toolCallsFromText(undefined, names), []);
});

test("every model call is steadier (temperature, room to answer) and its token counts land in the trace", async () => {
  const seen: any[] = [];
  const ai: AiBinding = {
    async run(_m, inputs) {
      seen.push(inputs);
      return seen.length === 1
        ? { tool_calls: [{ name: "whoami", arguments: {} }], usage: { prompt_tokens: 1834, completion_tokens: 12 } }
        : { response: "done", usage: { prompt_tokens: 1990, completion_tokens: 30 } };
    },
  };
  const result = await runToolLoop({ ai, model: "m", systemPrompt: "s", prompt: "who?", tools: echoTools, callTool: async () => "{}" });
  for (const inputs of seen) {
    assert.equal(inputs.temperature, DEFAULT_TEMPERATURE);
    assert.equal(inputs.max_tokens, DEFAULT_MAX_TOKENS);
  }
  assert.deepEqual(result.trace.map((t) => [t.outcome, t.toolsOffered, t.promptTokens, t.completionTokens]), [
    ["tool_calls", echoTools.length, 1834, 12],
    ["answer", echoTools.length, 1990, 30],
  ]);
  assert.deepEqual(result.trace[0].toolCalls, [{ name: "whoami", arguments: {} }]);
  assert.ok(!JSON.stringify(result.trace).includes("eyJ"), "no token-like strings in the trace");
});

test("a tool without parameters is offered plainly; other schemas keep their shape", () => {
  // What MCP SDK v2 lists for z.object({}):
  const sdkEmpty = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false };
  assert.deepEqual(toModelTool({ name: "whoami", description: "d", inputSchema: sdkEmpty }).parameters, { type: "object", properties: {} });
  assert.deepEqual(toModelTool({ name: "w", inputSchema: {} }).parameters, { type: "object", properties: {} });
  const withArgs = {
    $schema: "x",
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  };
  assert.deepEqual(toModelTool({ name: "echo", inputSchema: withArgs }).parameters, {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  });
  assert.equal(toModelTool({ name: "n", title: "T", inputSchema: {} }).description, "T");
});

const liveTools = [
  ...tools,
  { name: "microsoft_graph_list_properties", description: "[enterprise MCP server] Lists properties", inputSchema: { type: "object", properties: { entity: { type: "string" } } } },
  { name: "microsoft_graph_batch", description: "[enterprise MCP server] Batch", inputSchema: { type: "object", properties: { requests: { type: "array" } } } },
  { name: "echo_server_whoami", description: "[echo MCP server] Who is calling this MCP server? Takes no arguments.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "echo_server_echo",
    description: "[echo MCP server] Repeats a text the user gives",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
  },
];
const WHOAMI_RESULT = '{"flow":"agent-obo","clientAppId":"d0bfefed-ab08-4c59-9ca3-a5bd809f1265","parentBlueprintAppId":"954f42d1-c2e9-4c63-bc18-a908a9c5c6db"}';

/** Replays model replies in order; records what each call was offered. */
function replay(replies: unknown[]) {
  const offered: number[] = [];
  const ai: AiBinding = {
    async run(_m, inputs) {
      offered.push(((inputs.tools as unknown[] | undefined) ?? []).length);
      return replies[offered.length - 1] ?? { response: "(no more replies)" };
    },
  };
  return { ai, offered };
}

test("live replay, Llama 3.3: no tool, then echo_server_whoami() written as text, then the answer", async () => {
  const { ai } = replay([
    { response: "More information is needed to complete your request. Please provide additional details or clarify your task." },
    { response: "echo_server_whoami()" },
    { response: "The echo server sees agent identity d0bfefed-ab08-4c59-9ca3-a5bd809f1265 acting for you (agent-obo)." },
  ]);
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", systemPrompt: "s", prompt: "Ask the echo server who is calling it", tools: liveTools,
    callTool: async (name, args) => { invoked.push(`${name} ${JSON.stringify(args)}`); return WHOAMI_RESULT; },
  });
  assert.deepEqual(invoked, ["echo_server_whoami {}"]);
  assert.deepEqual(result.trace.map((t) => t.outcome), ["asked_again", "tool_calls", "answer"]);
  assert.equal(result.trace[1].toolCallsFromText, true);
  assert.equal(result.trace[1].text, "echo_server_whoami()");
  assert.match(result.answer, /agent-obo/);
  assert.equal(result.completed, true);
});

test("live replay, Llama 4 Scout: [echo_server_whoami] written as text is run straight away", async () => {
  const { ai } = replay([
    { response: "[echo_server_whoami]" },
    { response: "The echo MCP server sees the agent identity acting on behalf of you: flow agent-obo." },
  ]);
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai, model: "@cf/meta/llama-4-scout-17b-16e-instruct", systemPrompt: "s", prompt: "Ask the echo server who is calling it", tools: liveTools,
    callTool: async (name) => { invoked.push(name); return WHOAMI_RESULT; },
  });
  assert.deepEqual(invoked, ["echo_server_whoami"]);
  assert.deepEqual(result.trace.map((t) => t.outcome), ["tool_calls", "answer"]);
  assert.equal(result.steps, 2);
});

test("asked to answer, a model that writes the call again gets the last tool result as its answer", async () => {
  const { ai, offered } = replay([
    { response: "[echo_server_whoami {}]" },
    { response: "[echo_server_whoami {}]" },
    { response: "[echo_server_whoami {}]" },
  ]);
  const invoked: string[] = [];
  const result = await runToolLoop({
    ai, model: "m", systemPrompt: "s", prompt: "Ask the echo server who is calling it", tools: liveTools,
    callTool: async (name) => { invoked.push(name); return WHOAMI_RESULT; },
  });
  assert.deepEqual(invoked, ["echo_server_whoami"], "the repeated call runs once");
  assert.deepEqual(offered, [6, 6, 0], "after a step with nothing new, no tools are offered");
  assert.deepEqual(result.trace.map((t) => t.outcome), ["tool_calls", "tool_calls", "call_instead_of_answer"]);
  assert.match(result.answer, /^The model did not write an answer/);
  assert.match(result.answer, /Result of echo_server_whoami:\n\{"flow":"agent-obo"/);
  assert.equal(result.completed, false, "not remembered as an answered turn");
});

test("tool calls written in Python style or brackets", () => {
  const index = new Map<string, readonly string[]>([
    ["echo_server_whoami", []],
    ["echo_server_echo", ["message"]],
    ["microsoft_graph_get", ["relativeUrl", "headers"]],
  ]);
  const one = (name: string, args: Record<string, unknown> = {}) => [{ name, arguments: args }];
  assert.deepEqual(toolCallsFromText("echo_server_whoami()", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText("[echo_server_whoami]", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText("[echo_server_whoami {}]", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText("[echo_server_whoami()]", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText("echo_server_whoami().", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText("<|python_start|>[echo_server_whoami()]<|python_end|>", index), one("echo_server_whoami"));
  assert.deepEqual(toolCallsFromText('echo_server_echo(message="hi, there")', index), one("echo_server_echo", { message: "hi, there" }));
  assert.deepEqual(toolCallsFromText("echo_server_echo(message='hi')", index), one("echo_server_echo", { message: "hi" }));
  assert.deepEqual(toolCallsFromText("echo_server_echo('it\\'s')", index), one("echo_server_echo", { message: "it's" }));
  assert.deepEqual(toolCallsFromText('echo_server_echo("hello")', index), one("echo_server_echo", { message: "hello" }), "positional, by parameter order");
  assert.deepEqual(toolCallsFromText('echo_server_echo({"message": "x"})', index), one("echo_server_echo", { message: "x" }));
  assert.deepEqual(toolCallsFromText('echo_server_echo: {"message": "x"}', index), one("echo_server_echo", { message: "x" }));
  assert.deepEqual(
    toolCallsFromText('[microsoft_graph_get(relativeUrl="/users?$count=true", headers={"ConsistencyLevel": "eventual"}), echo_server_whoami()]', index),
    [
      { name: "microsoft_graph_get", arguments: { relativeUrl: "/users?$count=true", headers: { ConsistencyLevel: "eventual" } } },
      { name: "echo_server_whoami", arguments: {} },
    ],
  );
  assert.deepEqual(toolCallsFromText("```python\necho_server_whoami()\n```", index), one("echo_server_whoami"));
  // Not calls:
  assert.deepEqual(toolCallsFromText("echo_server_whoami", index), [], "a bare name outside brackets is text");
  assert.deepEqual(toolCallsFromText("I called echo_server_whoami() for you.", index), [], "prose that mentions a call");
  assert.deepEqual(toolCallsFromText("[unknown_tool()]", index), []);
  assert.deepEqual(toolCallsFromText("[echo_server_whoami(), rm_rf()]", index), [], "any unknown name: not a call");
  assert.deepEqual(toolCallsFromText('echo_server_echo("a", "b")', index), [], "more positional values than parameters");
  assert.deepEqual(toolCallsFromText("There are 4 guest users.", index), []);
  assert.deepEqual(toolCallsFromText("[1, 2, 3]", index), []);
});
