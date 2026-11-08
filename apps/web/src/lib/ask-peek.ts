import { matchExcerpt, tokenize, type AskPlanQuery, type AskSourceRef, type MatchNeedle } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { sourceThread } from "./ask";

/**
 * Plan 161, pass 3: a cited message shown inside Ask, so checking the evidence never loses the answer. Its text is read
 * from this Mac (`threads.get`: no model, nothing marked read), and the passage is the first sentence holding a word
 * the turn's own searches looked for, when one does. Esc or Back to the answer goes back; Open message, to the reader.
 */
export interface Peek {
  source: AskSourceRef;
  n: number;
  threadId: number;
  needles: MatchNeedle[];
  state: "loading" | "ready" | "failed";
  text: string;
  passage: string | null;
}

export const usePeek = create<{ peek: Peek | null }>(() => ({ peek: null }));

/** The words a turn's searches looked for in a message's text (its terms and every any-of group's words). */
export function needlesOf(queries: readonly AskPlanQuery[]): MatchNeedle[] {
  const out: MatchNeedle[] = [];
  const seen = new Set<string>();
  for (const q of queries)
    for (const value of [...q.terms, ...(q.anyOf ?? []).flat()]) {
      const words = tokenize(value);
      const key = words.join(" ");
      if (!words.length || seen.has(key)) continue;
      seen.add(key);
      out.push({ words, prefix: false });
    }
  return out;
}

/** The passage: the first sentence that holds one of the words, or null (then the text starts the preview). */
export const passageOf = (text: string, needles: readonly MatchNeedle[]): string | null => (needles.length ? matchExcerpt(text, needles) : null);

/** A message's words: its text part, or its HTML's text (an inert parse: nothing it names is fetched), or its snippet. */
export function messageText(m: { bodyText: string | null; bodyHtml: string | null; snippet: string }): string {
  if (m.bodyText?.trim()) return m.bodyText.trim();
  if (m.bodyHtml) {
    const doc = new DOMParser().parseFromString(m.bodyHtml, "text/html");
    for (const el of doc.querySelectorAll("style, script, head, title")) el.remove();
    for (const el of doc.querySelectorAll("br")) el.replaceWith("\n");
    for (const el of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, blockquote")) el.append("\n");
    const text = (doc.body?.textContent ?? "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
    if (text) return text;
  }
  return m.snippet;
}

let seq = 0;

/** A citation or a source row: the message, in Ask. A source that can't be shown (gone, or Spam/Trash once) stays put. */
export async function showSource(source: AskSourceRef, n: number, queries: readonly AskPlanQuery[]): Promise<void> {
  const mine = ++seq;
  const threadId = await sourceThread(source);
  if (threadId === null || mine !== seq) return;
  const needles = needlesOf(queries);
  usePeek.setState({ peek: { source, n, threadId, needles, state: "loading", text: "", passage: null } });
  const detail = await client.call("threads.get", { threadId }).catch(() => null);
  if (mine !== seq || usePeek.getState().peek?.source.messageId !== source.messageId) return;
  const message = detail?.messages.find((m) => m.id === source.messageId);
  if (!message) return usePeek.setState({ peek: { source, n, threadId, needles, state: "failed", text: "", passage: null } });
  const text = messageText(message);
  usePeek.setState({ peek: { source, n, threadId, needles, state: "ready", text, passage: passageOf(text, needles) } });
}

/** Esc and Back to the answer: whether there was one to close. */
export function closePeek(): boolean {
  seq++;
  if (!usePeek.getState().peek) return false;
  usePeek.setState({ peek: null });
  return true;
}
