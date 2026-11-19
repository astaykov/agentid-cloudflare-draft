/**
 * Conversation memory of the interactive agent: the last few question/answer pairs of one
 * user's chat, kept in the Agent's (Durable Object's) state. Durable means it survives
 * between requests, deployments and days, so the memory needs an end:
 *
 *   - after CHAT_MEMORY_MINUTES without a chat message (default 30; 0 = no memory),
 *   - when a request asks for a new conversation ({"newConversation": true}, CLI chat --new),
 *   - on POST /api/reset.
 *
 * Only answered turns are remembered: a question without an answer would come back in the
 * next request as an open question, and small models answer it again.
 *
 * No package imports, so the Node tests use it directly.
 */
import type { ChatMessage } from "../shared/agent/tool-loop.ts";

export const DEFAULT_MEMORY_MINUTES = 30;
/** Four question/answer pairs. */
export const MAX_HISTORY_MESSAGES = 8;

export interface ConversationState {
  history: ChatMessage[];
  lastActiveAt?: string;
}

export interface Conversation {
  /** What the model sees before the new question. */
  history: ChatMessage[];
  /** Earlier questions in `history`. */
  earlierTurns: number;
  /** Set when earlier messages existed but were left out, and why. */
  startedFresh?: "requested" | "expired" | "memory_off";
}

/** CHAT_MEMORY_MINUTES: empty or invalid = the default, 0 = no memory. */
export function memoryMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MEMORY_MINUTES;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_MEMORY_MINUTES;
}

export function currentConversation(
  state: ConversationState,
  options: { now: number; minutes: number; newConversation?: boolean },
): Conversation {
  const history = state.history ?? [];
  if (!history.length) return { history: [], earlierTurns: 0 };
  if (options.newConversation) return { history: [], earlierTurns: 0, startedFresh: "requested" };
  if (options.minutes === 0) return { history: [], earlierTurns: 0, startedFresh: "memory_off" };
  const last = state.lastActiveAt ? Date.parse(state.lastActiveAt) : Number.NaN;
  if (!Number.isFinite(last) || options.now - last > options.minutes * 60_000) {
    return { history: [], earlierTurns: 0, startedFresh: "expired" };
  }
  return { history, earlierTurns: history.filter((m) => m.role === "user").length };
}

/** The history to store after an ANSWERED turn. */
export function rememberTurn(history: ChatMessage[], prompt: string, answer: string): ChatMessage[] {
  return [
    ...history,
    { role: "user" as const, content: prompt.slice(0, 2000) },
    { role: "assistant" as const, content: answer.slice(0, 2000) },
  ].slice(-MAX_HISTORY_MESSAGES);
}
