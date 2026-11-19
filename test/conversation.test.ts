import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentConversation,
  DEFAULT_MEMORY_MINUTES,
  MAX_HISTORY_MESSAGES,
  memoryMinutes,
  rememberTurn,
} from "../src/interactive/conversation.ts";

const NOW = Date.parse("2026-11-19T16:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const history = rememberTurn([], "How many guest users are in my tenant?", "There are 4 guest users.");

test("CHAT_MEMORY_MINUTES: default 30, 0 = no memory, invalid values fall back to the default", () => {
  assert.equal(memoryMinutes(undefined), DEFAULT_MEMORY_MINUTES);
  assert.equal(memoryMinutes(""), 30);
  assert.equal(memoryMinutes("0"), 0);
  assert.equal(memoryMinutes("120"), 120);
  assert.equal(memoryMinutes("-5"), 30);
  assert.equal(memoryMinutes("soon"), 30);
});

test("earlier turns reach the model only while the conversation is fresh", () => {
  const fresh = currentConversation({ history, lastActiveAt: minutesAgo(10) }, { now: NOW, minutes: 30 });
  assert.equal(fresh.earlierTurns, 1);
  assert.equal(fresh.history.length, 2);
  assert.equal(fresh.startedFresh, undefined);

  // The guest users question from days ago does not come back.
  const old = currentConversation({ history, lastActiveAt: minutesAgo(3 * 24 * 60) }, { now: NOW, minutes: 30 });
  assert.deepEqual(old, { history: [], earlierTurns: 0, startedFresh: "expired" });

  const asked = currentConversation({ history, lastActiveAt: minutesAgo(1) }, { now: NOW, minutes: 30, newConversation: true });
  assert.deepEqual(asked, { history: [], earlierTurns: 0, startedFresh: "requested" });

  const off = currentConversation({ history, lastActiveAt: minutesAgo(1) }, { now: NOW, minutes: 0 });
  assert.equal(off.startedFresh, "memory_off");

  const noTime = currentConversation({ history }, { now: NOW, minutes: 30 });
  assert.equal(noTime.startedFresh, "expired", "state without lastActiveAt is not trusted");

  assert.deepEqual(currentConversation({ history: [] }, { now: NOW, minutes: 30, newConversation: true }), { history: [], earlierTurns: 0 });
});

test("the memory keeps the last four question/answer pairs", () => {
  let h = rememberTurn([], "q1", "a1");
  for (let i = 2; i <= 6; i++) h = rememberTurn(h, `q${i}`, `a${i}`);
  assert.equal(h.length, MAX_HISTORY_MESSAGES);
  assert.equal(h[0].content, "q3");
  assert.equal(h.at(-1)?.content, "a6");
  assert.equal(rememberTurn([], "x".repeat(5000), "y").at(0)?.content.length, 2000);
});
