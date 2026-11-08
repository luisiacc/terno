import { t } from "@terno/i18n";
import { provenanceLabel } from "../lib/provenance";

/**
 * A model's words, not the sender's (plans 148 and 144): the design's card, so every AI suggestion in the reader looks one
 * way in every style. Its edges are on the conversation's column, and its text inset.
 *
 * Plan 161: one anatomy for every suggestion (the summary, Reply ready, the follow-up line, ⌘J's strip): a header (glyph,
 * a title in the ink, then what it's about), the body, and a row of BoardUI buttons at one height.
 */
export const AI_CARD = "card-group";
/** The header's glyph (Sparkles, or the spinner while it works), the size of the header's text. */
export const AI_GLYPH = "size-[1.15em] shrink-0 text-muted-foreground";
/** The header: one line of the secondary type, its glyph on the first line. */
export const AI_HEADER = "flex min-h-10 items-center gap-1.5 py-2.5 text-xs text-muted-foreground";
/** The header's title: in the ink, so a card's name isn't its quietest word. */
export const AI_TITLE = "font-medium text-foreground";
/** The button row: the same gaps on every surface. Its buttons are `size="sm"` (28 px). */
export const AI_ACTIONS = "flex flex-wrap items-center gap-2";

/** "Written with AI", or "Edited after AI" once the user has typed in it: the strip's status, said one way. */
/** The ⌘J strip's status: the one provenance label (lib/provenance), or that it was edited since. */
export const aiWritten = (edited: boolean): string => (edited ? t("aiDraft.edited") : provenanceLabel());

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
