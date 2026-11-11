import { AI_GLYPH, AI_HEADER, AI_TITLE } from "./ai-card";
import type { AiLook } from "~/lib/ai-look";

/**
 * Exploration (explore/ai-card-variations), removed with the switch once the owner picks: what each look changes on the
 * summary and Reply ready. Surfaces are globals.css utilities on the palette's own tokens; text stays on the page's pairs.
 */
export interface AiLookSpec {
  /** the surface: its edge, fill and corners */
  card: string;
  /** the contents' inline padding, and the space under them */
  inset: string;
  bottom: string;
  /** the header row (Reply ready's, and the summary's states) and the summary's trigger in it */
  header: string;
  trigger: string;
  glyph: string;
  title: string;
  /** Copy and Written with AI: a footer row, or at the header's end */
  tools: "footer" | "header";
  /** Copy as its glyph alone */
  copyIcon: boolean;
  /** how the facts read: today's line, ruled rows, a label over each, or a glyph for each kind */
  items: "inline" | "ruled" | "stacked" | "glyphs";
  /** Reply ready's words: on the card, or in a hairline well inset in it, as the draft they'd become */
  draft: "card" | "well";
  /** Reply ready's surface and place under the last message, when not the card's own */
  reply?: string;
  /** below the summary, before the conversation */
  after: string;
}

const CURRENT: AiLookSpec = {
  card: "ai-card",
  inset: "px-4",
  bottom: "pb-3.5",
  header: AI_HEADER,
  trigger: "h-10 px-4",
  glyph: AI_GLYPH,
  title: AI_TITLE,
  tools: "footer",
  copyIcon: false,
  items: "inline",
  draft: "card",
  after: "mb-4",
};

/** roomier rows: the owner's airy over dense */
const ROOMY_HEADER = "flex min-h-11 items-center gap-2 py-3 text-sm text-muted-foreground";

export const AI_LOOK_SPECS: Record<AiLook, AiLookSpec> = {
  current: CURRENT,
  // 1 · a breath of the accent instead of a line: no edge, no shadow, the glyph in the accent
  whisper: {
    ...CURRENT,
    card: "ai-whisper",
    inset: "px-5",
    bottom: "pb-4",
    header: ROOMY_HEADER,
    trigger: "h-11 px-5",
    glyph: "size-[1.15em] shrink-0 text-primary",
    tools: "header",
    copyIcon: true,
    after: "mb-5",
  },
  // 2 · Mail's banner: no box, hairlines above and below, every line on the conversation's own left edge
  ledger: {
    ...CURRENT,
    card: "ai-ledger",
    inset: "px-0",
    bottom: "pb-3",
    header: "flex min-h-11 items-center gap-1.5 py-3 text-xs text-muted-foreground",
    trigger: "h-11 px-0",
    glyph: "size-[1.15em] shrink-0 text-muted-foreground",
    title: "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
    tools: "header",
    copyIcon: true,
    items: "ruled",
    draft: "well",
    // the last message's own hairline is its top rule
    reply: "ai-ledger-tail",
    after: "mb-5",
  },
  // 3 · a sheet lifted off the page: no hairline in light, a soft shadow; in dark the card's own step up and a top light
  float: {
    ...CURRENT,
    card: "ai-float",
    inset: "px-5",
    bottom: "pb-4",
    header: ROOMY_HEADER,
    trigger: "h-11 px-5",
    tools: "header",
    copyIcon: true,
    items: "stacked",
    after: "mb-6",
  },
  // 4 · an edge that catches the accent at its corner and fades to the hairline; each fact led by its kind's glyph
  edge: {
    ...CURRENT,
    card: "ai-edge",
    inset: "px-5",
    bottom: "pb-4",
    header: ROOMY_HEADER,
    trigger: "h-11 px-5",
    glyph: "size-[1.15em] shrink-0 text-primary",
    tools: "header",
    copyIcon: true,
    items: "glyphs",
    after: "mb-5",
  },
};
