import type { MessageDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { listDate } from "../lib/format";
import { provenanceLabel } from "../lib/provenance";

/**
 * A model's words, not the sender's (plans 148 and 144): the design's card, so every AI suggestion in the reader looks one
 * way in every style. Its edges are on the conversation's column, and its text inset.
 *
 * Plan 161: one anatomy for every suggestion (the summary, Reply ready, the follow-up line, ⌘J's strip): a header (glyph,
 * a title in the ink, then what it's about), the body, and a row of BoardUI buttons at one height.
 */
/** Plan 161, pass 2: ringed inside in card-edge (globals.css `ai-card`), so it never reads as part of the mail in any palette. */
export const AI_CARD = "ai-card";
/** The header's glyph (Sparkles, or the spinner while it works), the size of the header's text. */
export const AI_GLYPH = "size-[1.15em] shrink-0 text-muted-foreground";
/** The header: one line of the secondary type, its glyph on the first line. */
export const AI_HEADER = "flex min-h-10 items-center gap-1.5 py-2.5 text-xs text-muted-foreground";
/** The header's title: in the ink, so a card's name isn't its quietest word. */
export const AI_TITLE = "font-medium text-foreground";
/** The button row: the same gaps on every surface. Its buttons are `size="sm"` (28 px). */
export const AI_ACTIONS = "flex flex-wrap items-center gap-2";

/** The ⌘J strip's status: the one provenance label (lib/provenance), or that it was edited since, or stopped (pass 3). */
export const aiWritten = (edited: boolean, stopped = false): string => (edited ? t("aiDraft.edited") : stopped ? t("aiDraft.stopped") : provenanceLabel());

/**
 * Plan 161: a gap the model left (`[What you think.]`), marked wherever its words are shown, in the card and in the
 * composer: the search match's gold wash under the ink (`CONTRAST_PAIRS`, over the card's and the composer's surfaces).
 */
export const AI_GAP = "rounded-xs bg-star/25 px-px text-foreground";

/** The text in pieces: each of `gaps` found in it (exactly those strings, never any bracket) as a gap. */
export function gapPieces(text: string, gaps: readonly string[]): { text: string; gap: boolean }[] {
  const wanted = [...new Set(gaps.filter(Boolean))];
  if (!wanted.length) return [{ text, gap: false }];
  const re = new RegExp(wanted.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const out: { text: string; gap: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), gap: false });
    out.push({ text: m[0], gap: true });
    at = m.index + m[0].length;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), gap: false });
  return out;
}

/**
 * Plan 161, pass 2: where an AI line points, said (pass 3: named for where it goes, "Arjun’s message, Oct 21", "Your
 * message, 3:02 PM"), or nothing when the conversation is
 * that one message, already on screen. The summary's items and the follow-up line both go to a message.
 */
export function messageSource(messages: readonly Pick<MessageDetail, "id" | "from" | "date">[], messageId: number, mine: readonly string[], now = Date.now()): string | null {
  if (messages.length <= 1) return null;
  const m = messages.find((x) => x.id === messageId);
  if (!m) return t("summary.open");
  const date = listDate(m.date, now);
  if (mine.some((e) => e.toLowerCase() === m.from.email.toLowerCase())) return t("ai.source.yours", { date });
  return t("ai.source.label", { who: (m.from.name || m.from.email.split("@")[0] || m.from.email).split(/\s+/)[0]!, date });
}

/** Plan 161, pass 3: who wrote it and Copy, one of each on every AI surface (ai-provenance.tsx). */
export { AiCopyButton, AiProvenance } from "./ai-provenance";

/** Plan 161, pass 2: the one AI error, for every AI surface (the summary, ⌘J, Ask). */
export { AiErrorNotice, aiErrorCopy, errorTarget, hasAddress, type AiErrorCopy, type AiErrorInput, type AiErrorTarget } from "./ai-error";
