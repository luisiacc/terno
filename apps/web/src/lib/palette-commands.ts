import { defaultFilter } from "cmdk";
import type { ReactNode } from "react";
import { boost, recentIds, type Usage } from "./palette-usage";

/**
 * Plan 88: the palette's commands as records, how a query scores them, and
 * which groups show. Pure: the component builds the records and renders.
 */

export type PalettePage = "root" | "move" | "addTo" | "remind";
export type PaletteGroup = "draft" | "recent" | "goTo" | "actions" | "settings" | "move" | "addTo" | "remindAlways" | "remindNoReply" | "remindClear";

export interface PaletteCommand {
  /** stable across opens and languages: what usage counts ("thread.archive", "move:12", "remind:always:tomorrow") */
  id: string;
  group: PaletteGroup;
  label: string;
  /** how the label renders when it isn't plain text ("Settings → General" with the arrow hidden from screen readers) */
  display?: ReactNode;
  icon: ReactNode;
  /** what a query matches (the label when absent): may add context ("category Work", an email) */
  search?: string;
  /** the user's words for it, shown after the label when they're what matched */
  aliases?: readonly string[];
  /** matched, never shown (the English words in another language) */
  keywords?: readonly string[];
  /** muted text on the right, before the shortcut ("Tue 9:00 AM", an account's email) */
  hint?: string;
  shortcut?: string;
  testId?: string;
  disabled?: boolean;
  /** shown only once the user types (a page's values reached from the root) */
  searchOnly?: boolean;
  /** weighs the match (Superhuman's "scale"): a page's value at the root is 0.5, so a bare name finds the thing, not an action on it */
  scale?: number;
  /** Enter opens this page instead of running */
  page?: PalettePage;
  /** runs in the composer once focus is back in it (a draft command) */
  draft?: boolean;
  run?(): void;
}

/** the groups each page shows, in order */
export const PAGE_GROUPS: Record<PalettePage, readonly PaletteGroup[]> = {
  root: ["draft", "recent", "goTo", "actions", "settings"],
  move: ["move"],
  addTo: ["addTo"],
  remind: ["remindAlways", "remindNoReply", "remindClear"],
};

/**
 * The least a match must score to show (command-score: a word-start match is
 * ~0.9, a typo like "arhcive" ~0.1, letters scattered through a long label
 * ~0.003-0.03, which is noise).
 */
export const FLOOR = 0.05;

/** how many recent commands lead an empty root */
export const RECENT = 4;

/** The texts a command is matched by, in order: its search text, aliases, then keywords. */
const texts = (c: Pick<PaletteCommand, "label" | "search" | "aliases" | "keywords">): string[] => [c.search ?? c.label, ...(c.aliases ?? []), ...(c.keywords ?? [])];

/** The best score of any one text (never across two, as one concatenated string would), and the alias that gave it. */
/**
 * How much of a query is scored: a command is a few words, and a pasted
 * paragraph scored against every value would stall each keystroke
 * (command-score is ~linear in the query, per text). The search item keeps it all.
 */
export const MAX_QUERY = 64;

export function match(c: Pick<PaletteCommand, "label" | "search" | "aliases" | "keywords">, query: string): { score: number; alias: string | null } {
  const q = query.trim().slice(0, MAX_QUERY).trimEnd();
  if (!q) return { score: 1, alias: null };
  const all = texts(c);
  const aliases = c.aliases?.length ?? 0;
  let score = 0;
  let at = -1;
  all.forEach((text, i) => {
    const s = defaultFilter(text, q);
    if (s > score) {
      score = s;
      at = i;
    }
  });
  return { score, alias: at >= 1 && at <= aliases ? all[at]! : null };
}

/** The score with use: up to 1.5× for what you run often, never past an exact match. */
export function ranked(score: number, id: string, usage: Usage, now: number): number {
  if (score === 0) return 0;
  return Math.min(score * boost(usage.get(id), now), score === 1 ? 1 : 0.995);
}

/** A command's match, weighed by its scale, then by use; and the alias that matched. */
export function scored(c: PaletteCommand, query: string, usage: Usage, now: number): { score: number; alias: string | null } {
  const m = match(c, query);
  return { score: ranked(m.score * (c.scale ?? 1), c.id, usage, now), alias: m.alias };
}
export const scoreOf = (c: PaletteCommand, query: string, usage: Usage, now: number): number => scored(c, query, usage, now).score;

/** cmdk's item value: unique by id (the palette filters and orders itself, so cmdk only selects). */
export const itemValue = (c: Pick<PaletteCommand, "id" | "label">): string => `${c.id}\u0000${c.label}`;

export interface Shown {
  command: PaletteCommand;
  /** the synonym that matched, shown after the label */
  alias: string | null;
}
export interface Arranged {
  group: PaletteGroup;
  commands: Shown[];
}

/**
 * What the page shows, in order. With no query: the page's groups in their
 * order, without search-only commands; on the root, the recent commands lead
 * and leave their own groups. While typing: only what matches, best first
 * within each group and groups by their best (cmdk 1.1.1 can't reorder
 * groups: it looks them up by an id they don't carry), so many categories
 * render only their matches.
 */
export function arrange(commands: readonly PaletteCommand[], page: PalettePage, query: string, usage: Usage, now: number): Arranged[] {
  const groups = PAGE_GROUPS[page];
  const mine = commands.filter((c) => groups.includes(c.group));
  if (query.trim() !== "") {
    const hits = mine
      .map((command) => ({ command, ...scored(command, query, usage, now) }))
      .filter((s) => s.score >= FLOOR);
    const out: (Arranged & { best: number; order: number })[] = [];
    for (const [order, group] of groups.entries()) {
      const list = hits.filter((s) => s.command.group === group).sort((a, b) => b.score - a.score);
      if (list.length) out.push({ group, commands: list.map(({ command, alias }) => ({ command, alias })), best: list[0]!.score, order });
    }
    return out.sort((a, b) => b.best - a.best || a.order - b.order).map(({ group, commands }) => ({ group, commands }));
  }
  let recent: PaletteCommand[] = [];
  if (page === "root") {
    // a draft's commands are already first; recent ones come from everything else at the root (values too)
    const pool = mine.filter((c) => c.group !== "draft" && !c.page && !c.disabled);
    const ids = recentIds(usage, new Set(pool.map((c) => c.id)), RECENT);
    const byId = new Map(pool.map((c) => [c.id, c]));
    recent = ids.map((id) => ({ ...byId.get(id)!, group: "recent" as const }));
  }
  const taken = new Set(recent.map((c) => c.id));
  const shown = mine.filter((c) => !c.searchOnly && !taken.has(c.id));
  return groups
    .map((group) => ({ group, commands: (group === "recent" ? recent : shown.filter((c) => c.group === group)).map((command) => ({ command, alias: null })) }))
    .filter((g) => g.commands.length > 0);
}

/** A localized comma-separated list ("done, mark done") as words. */
export const words = (list: string): string[] =>
  list
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
