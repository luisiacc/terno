import { matchExcerpt, tokenize, type AskPlanQuery, type AskSourceRef, type AskSourceView, type MatchNeedle } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { sourceThread, useAsk } from "./ask";

/**
 * Plan 161, pass 3: a cited message shown inside Ask, so checking the evidence never loses the answer. Its text is read
 * from this Mac (`threads.get`: no model, nothing marked read), and the passage is the first sentence holding a word
 * the turn's own searches looked for, when one does. Esc or Back to the answer goes back; Open message, to the reader.
 */
export interface Peek {
  source: AskSourceRef;
  n: number;
  threadId: number;
  /** where it was when it was let through: Open message asks again only if it has moved since */
  approved: Exclude<AskSourceView["state"], "gone">;
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
  // Codex review (pass 3) #2: an answer from before another conversation began is that conversation's no longer
  const conversation = useAsk.getState().conversationId;
  const current = () => mine === seq && useAsk.getState().conversationId === conversation;
  const at = await sourceThread(source, undefined, current);
  if (at === null || !current()) return;
  const needles = needlesOf(queries);
  const base = { source, n, threadId: at.threadId, approved: at.state, needles };
  usePeek.setState({ peek: { ...base, state: "loading", text: "", passage: null } });
  const detail = await client.call("threads.get", { threadId: at.threadId }).catch(() => null);
  if (!current() || usePeek.getState().peek?.source.messageId !== source.messageId) return;
  const message = detail?.messages.find((m) => m.id === source.messageId);
  if (!message) return usePeek.setState({ peek: { ...base, state: "failed", text: "", passage: null } });
  const text = messageText(message);
  usePeek.setState({ peek: { ...base, state: "ready", text, passage: passageOf(text, needles) } });
}

// another conversation (New question, Previous AI questions, one cleared elsewhere): a source shown was the last one's
useAsk.subscribe((s, prev) => {
  if (s.conversationId !== prev.conversationId || (s.turns.length === 0 && prev.turns.length > 0)) closePeek();
});

/** Esc and Back to the answer: whether there was one to close. */
export function closePeek(): boolean {
  seq++;
  if (!usePeek.getState().peek) return false;
  usePeek.setState({ peek: null });
  return true;
}
