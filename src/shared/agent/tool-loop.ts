/**
 * A small "LLM + MCP tools" loop on Workers AI.
 *
 * The model only ever sees tool names, schemas and tool RESULTS. Access tokens
 * stay in the token service and the MCP client; they are never put in a prompt.
 *
 * Guard rails for small models:
 *   - a call the model repeats in the same turn (same tool, same arguments) runs once, and
 *     when a step brings nothing new the model must answer;
 *   - every tool result message restates the user's latest question, so an earlier question
 *     in the conversation history is not mistaken for the one to answer;
 *   - when the first reply calls no tool although tools were offered (for example "Your input
 *     is incomplete"), the model is asked once more, plainly, to call the tool that fits;
 *   - a tool call the model wrote as text ({"name": ..., "parameters": ...}, f(), [f {}],
 *     <function=f>{...}</function>) is run like a regular tool call, and a final reply that is
 *     only another call is replaced by the last tool result;
 *   - a low temperature (DEFAULT_TEMPERATURE) for steadier tool choice.
 *
 * Every model call is recorded in `trace` (what was offered, what came back, token counts
 * when Workers AI reports them). The trace never contains tokens of any kind.
 */
import type { McpTool } from "../mcp/mcp-client.ts";

/** The subset of the Workers AI binding we use (typed loosely so any model id works). */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCallRecord {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** First characters of the tool result, for traceability. */
  preview: string;
}

/** Workers AI's default for Llama 3.3 is 0.6; tool choice is steadier lower down. */
export const DEFAULT_TEMPERATURE = 0.2;
/** Workers AI's default is 256 tokens, short for an answer that lists directory objects. */
export const DEFAULT_MAX_TOKENS = 1024;

export interface ToolLoopOptions {
  ai: AiBinding;
  model: string;
  systemPrompt: string;
  prompt: string;
  history?: ChatMessage[];
  tools: McpTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  temperature?: number;
  maxTokens?: number;
}

/** One model call: what it was offered and what it returned. */
export interface ToolLoopStep {
  step: number;
  /** Tools offered to the model in this call (0 = it had to answer). */
  toolsOffered: number;
  /**
   * tool_calls: it called tools; answer: it answered; empty: no text and no tool call;
   * asked_again: its first reply called no tool, so it was asked once more;
   * call_instead_of_answer: asked to answer, it wrote another tool call, so the answer shows
   * the last tool result.
   */
  outcome: "tool_calls" | "answer" | "empty" | "asked_again" | "call_instead_of_answer";
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** The model wrote its tool call as text instead of using the tool call format. */
  toolCallsFromText?: boolean;
  /** The first 400 characters of the model's text. */
  text?: string;
  /** Token counts, when Workers AI reports them. */
  promptTokens?: number;
  completionTokens?: number;
}

export interface ToolLoopResult {
  answer: string;
  /** One record per call that ran; repeated identical calls are not run again. */
  toolCalls: ToolCallRecord[];
  steps: number;
  /** False when the model produced no final answer: such a turn should not be remembered. */
  completed: boolean;
  /** One entry per model call. */
  trace: ToolLoopStep[];
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface ParsedModelOutput {
  text?: string;
  toolCalls: ParsedToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // ignore: treated as no arguments
    }
  }
  return {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Accepts both Workers AI "traditional" output and OpenAI-style chat completions. */
export function parseModelOutput(raw: unknown): ParsedModelOutput {
  const out: ParsedModelOutput = { toolCalls: [] };
  if (!raw || typeof raw !== "object") return { text: typeof raw === "string" ? raw : undefined, toolCalls: [] };
  const r = raw as Record<string, any>;
  if (typeof r.response === "string") out.text = r.response;
  else if (r.response && typeof r.response === "object") out.text = JSON.stringify(r.response);
  for (const call of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
    const name = call?.name ?? call?.function?.name;
    if (typeof name === "string") out.toolCalls.push({ name, arguments: parseArguments(call.arguments ?? call?.function?.arguments) });
  }
  const message = Array.isArray(r.choices) ? r.choices[0]?.message : undefined;
  if (message) {
    if (typeof message.content === "string" && !out.text) out.text = message.content;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = call?.function?.name ?? call?.name;
      if (typeof name === "string") out.toolCalls.push({ name, arguments: parseArguments(call?.function?.arguments ?? call.arguments) });
    }
  }
  if (r.usage && typeof r.usage === "object") {
    out.usage = { promptTokens: count(r.usage.prompt_tokens), completionTokens: count(r.usage.completion_tokens) };
  }
  return out;
}

/** Offered tool names, optionally with their parameter names in order (for positional arguments). */
export type ToolIndex = ReadonlySet<string> | ReadonlyMap<string, readonly string[]>;

const NAME = "[A-Za-z_][\\w.-]*";

/** Splits at top-level separators: not inside quotes, (), [] or {}. */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) current += text[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (depth === 0 && separators.includes(ch)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A Python or JSON literal: "x", 'x', 1, true/True, null/None, {...}, [...]; anything else stays text. */
function literal(raw: string): unknown {
  const value = raw.trim();
  try {
    return JSON.parse(value);
  } catch {
    // not JSON
  }
  if (/^'[\s\S]*'$/.test(value)) return value.slice(1, -1).replace(/\\'/g, "'");
  if (value === "True") return true;
  if (value === "False") return false;
  if (value === "None") return null;
  return value;
}

/** f(a=1, b="x"), f("x") (positional, by the tool's parameter order), f({"a": 1}) or f(). */
function callArguments(text: string, parameters: readonly string[] | undefined): Record<string, unknown> | undefined {
  const body = text.trim();
  if (!body) return {};
  if (body.startsWith("{")) {
    const object = jsonObject(body);
    if (object) return object;
  }
  const args: Record<string, unknown> = {};
  let position = 0;
  for (const part of splitTopLevel(body, ",")) {
    const named = /^([A-Za-z_]\w*)\s*[=:]\s*([\s\S]+)$/.exec(part);
    if (named) {
      args[named[1]] = literal(named[2]);
      continue;
    }
    const name = parameters?.[position++];
    if (!name) return undefined;
    args[name] = literal(part);
  }
  return args;
}

/**
 * Tool calls a model wrote as text instead of returning them as tool calls. Seen on Workers AI:
 * Llama 3.3 wrote echo_server_whoami(), Llama 4 Scout wrote [echo_server_whoami] and
 * [echo_server_whoami {}]. Recognised, when they make up the whole reply:
 *   {"name": "f", "parameters": {...}}, a list of those, {"type": "function", "function": {...}}
 *   <function=f>{...}</function>
 *   f(), f(a=1, b="x"), f("x"), [f(), g(a=1)]          (Python style, Llama's own format)
 *   [f], [f {...}], f {...}, f: {...}
 * optionally after <|python_tag|> or between <|python_start|> and <|python_end|>, or inside a
 * code fence. Only names of offered tools count, so an ordinary answer is never mistaken for a call.
 */
export function toolCallsFromText(text: string | undefined, tools: ToolIndex): ParsedToolCall[] {
  if (!text) return [];
  const offered = (name: string) => tools.has(name);
  const parameters = (name: string) => (tools instanceof Map ? tools.get(name) : undefined);
  let body = text
    .trim()
    .replace(/^<\|python_tag\|>/, "")
    .replace(/^<\|python_start\|>([\s\S]*?)(?:<\|python_end\|>)?$/, "$1")
    .trim();
  const fenced = /^```[\w-]*\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  body = body.replace(/[.;]+$/, "").trim();

  const known = (calls: ParsedToolCall[]) => (calls.length > 0 && calls.every((c) => offered(c.name)) ? calls : []);

  const tagged = [...body.matchAll(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g)];
  if (tagged.length) return known(tagged.map((m) => ({ name: m[1], arguments: parseArguments(m[2]) })));

  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(body);
      const calls: ParsedToolCall[] = [];
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const record = item && typeof item === "object" ? (item as Record<string, any>) : undefined;
        const fn = record?.function && typeof record.function === "object" ? record.function : record;
        if (typeof fn?.name === "string") calls.push({ name: fn.name, arguments: parseArguments(fn.parameters ?? fn.arguments) });
      }
      return known(calls);
    } catch {
      // not JSON: maybe Python style or [name {...}], below
    }
  }

  const bracketed = body.startsWith("[") && body.endsWith("]");
  const inner = bracketed ? body.slice(1, -1).trim() : body;
  const calls: ParsedToolCall[] = [];
  for (const item of splitTopLevel(inner, ",\n")) {
    const pythonic = new RegExp(`^(${NAME})\\s*\\(([\\s\\S]*)\\)$`).exec(item);
    if (pythonic) {
      const args = callArguments(pythonic[2], parameters(pythonic[1]));
      if (!args) return [];
      calls.push({ name: pythonic[1], arguments: args });
      continue;
    }
    const withObject = new RegExp(`^(${NAME})\\s*:?\\s*(\\{[\\s\\S]*\\})$`).exec(item);
    if (withObject) {
      const args = jsonObject(withObject[2]);
      if (!args) return [];
      calls.push({ name: withObject[1], arguments: args });
      continue;
    }
    // A bare name is a call only inside brackets: [echo_server_whoami].
    if (bracketed && new RegExp(`^${NAME}$`).test(item)) {
      calls.push({ name: item, arguments: {} });
      continue;
    }
    return [];
  }
  return known(calls);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Same tool and same arguments (in any order) = the same call. */
export function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}\u0000${stableStringify(args)}`;
}

/** Keeps the first of identical calls the model put into one step. */
export function uniqueCalls<T extends { name: string; arguments: Record<string, unknown> }>(calls: T[]): T[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = callKey(call.name, call.arguments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * A tool as Workers AI expects it. A tool without parameters is offered as a plain
 * {"type": "object", "properties": {}}, without additionalProperties or required, which MCP
 * SDK v2 adds for an empty schema (z.object({})).
 */
export function toModelTool(tool: McpTool) {
  const description = (tool.description ?? tool.title ?? tool.name).slice(0, 1000);
  const schema = { ...(tool.inputSchema ?? {}) } as Record<string, unknown>;
  delete schema.$schema;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0) {
    return { name: tool.name, description, parameters: { type: "object", properties: {} } };
  }
  if (schema.type !== "object") schema.type = "object";
  return { name: tool.name, description, parameters: schema };
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxSteps = options.maxSteps ?? 6;
  const maxPerStep = options.maxToolCallsPerStep ?? 3;
  const sampling = { temperature: options.temperature ?? DEFAULT_TEMPERATURE, max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS };
  const toolNames = new Set(options.tools.map((t) => t.name));
  const modelTools = options.tools.map(toModelTool);
  /** Offered names with their parameter names, for calls the model writes as text. */
  const toolIndex: ToolIndex = new Map(modelTools.map((t) => [t.name, Object.keys(t.parameters.properties as Record<string, unknown>)]));
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...(options.history ?? []),
    { role: "user", content: options.prompt },
  ];
  const question = excerpt(options.prompt, 600);
  const toolCalls: ToolCallRecord[] = [];
  const trace: ToolLoopStep[] = [];
  /** Calls already run in this turn (same tool, same arguments). */
  const done = new Set<string>();
  let mustAnswer = false;
  let askedAgain = false;
  let lastResult: { tool: string; text: string } | undefined;

  for (let step = 1; step <= maxSteps; step++) {
    const allowTools = step < maxSteps && modelTools.length > 0 && !mustAnswer;
    const raw = await options.ai.run(options.model, allowTools ? { messages, tools: modelTools, ...sampling } : { messages, ...sampling });
    const parsed = parseModelOutput(raw);
    const text = (parsed.text ?? "").trim();
    const entry: ToolLoopStep = {
      step,
      toolsOffered: allowTools ? modelTools.length : 0,
      outcome: "answer",
      ...(parsed.usage?.promptTokens !== undefined ? { promptTokens: parsed.usage.promptTokens } : {}),
      ...(parsed.usage?.completionTokens !== undefined ? { completionTokens: parsed.usage.completionTokens } : {}),
    };
    trace.push(entry);

    let modelCalls = parsed.toolCalls;
    if (allowTools && modelCalls.length === 0) {
      modelCalls = toolCallsFromText(text, toolIndex);
      if (modelCalls.length) {
        entry.toolCallsFromText = true;
        entry.text = excerpt(text, 400);
      }
    }

    if (!allowTools || modelCalls.length === 0) {
      if (text) entry.text = excerpt(text, 400);
      // The first reply called no tool although tools were offered: ask once more, plainly.
      if (allowTools && !askedAgain && toolCalls.length === 0) {
        askedAgain = true;
        entry.outcome = "asked_again";
        messages.push({ role: "assistant", content: text || "(no answer)" });
        messages.push({
          role: "user",
          content:
            `Answer my question by calling the tool that fits, then answer from its result. Your tools: ${[...toolNames].join(", ")}. ` +
            `A tool without parameters is called with empty arguments {}. Only if none of the tools fits, answer without one. ` +
            `My question: "${question}"`,
        });
        continue;
      }
      // Asked to answer, the model wrote another tool call: show what the last tool returned.
      if (!allowTools && lastResult && toolCallsFromText(text, toolIndex).length > 0) {
        entry.outcome = "call_instead_of_answer";
        const shown = lastResult.text.length > 1500 ? `${lastResult.text.slice(0, 1500)}...` : lastResult.text;
        return {
          answer: `The model did not write an answer (it asked for ${excerpt(text, 80)} again). Result of ${lastResult.tool}:\n${shown}`,
          toolCalls,
          steps: step,
          completed: false,
          trace,
        };
      }
      entry.outcome = text ? "answer" : "empty";
      return { answer: text || "(the model returned no text)", toolCalls, steps: step, completed: Boolean(text), trace };
    }

    const calls = uniqueCalls(modelCalls).slice(0, maxPerStep);
    entry.outcome = "tool_calls";
    entry.toolCalls = calls.map((c) => ({ name: c.name, arguments: c.arguments }));
    const results: string[] = [];
    let ran = 0;
    for (const call of calls) {
      const key = callKey(call.name, call.arguments);
      if (done.has(key)) {
        results.push(`${call.name}(${JSON.stringify(call.arguments)}) was already called in this turn; its result is above. Do not call it again.`);
        continue;
      }
      done.add(key);
      ran++;
      let result: string;
      let ok = false;
      if (!toolNames.has(call.name)) {
        result = `Unknown tool '${call.name}'. The only tools are: ${[...toolNames].join(", ")}. Do not guess tool names; if no tool fits, say so.`;
      } else {
        try {
          result = await options.callTool(call.name, call.arguments);
          ok = true;
          lastResult = { tool: call.name, text: result };
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      toolCalls.push({ tool: call.name, arguments: call.arguments, ok, preview: result.slice(0, 300) });
      results.push(`Result of ${call.name}(${JSON.stringify(call.arguments)}):\n${result}`);
    }
    // Nothing new in this step: the model is going round in circles, so it answers next.
    if (ran === 0) mustAnswer = true;
    // Tool results are passed back as plain messages: this works with every chat model on Workers AI.
    messages.push({
      role: "assistant",
      content: `I called: ${calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join("; ")}`,
    });
    messages.push({
      role: "user",
      content:
        `${results.join("\n\n")}\n\n` +
        (mustAnswer ? "Do not call more tools. " : "If you need more data, call another tool. Otherwise ") +
        `answer my latest question using only these results. My latest question: "${question}"`,
    });
  }
  return { answer: "Stopped after the maximum number of steps.", toolCalls, steps: maxSteps, completed: false, trace };
}
