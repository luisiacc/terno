import type { PeopleIndexState, PeopleList, PeopleSearch, PersonEntry, PersonItem, PersonOpen, PersonPage } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 281: People's state. The list as the backend last said it (Open, then Everyone), the search typed into it and its
 * hits, and the page of the person selected (`AppState.person`). Rows for the virtualized list are derived (`peopleRows`).
 */
export interface PeopleState {
  list: PeopleList | null;
  /** what's typed in the list's search ("" for none) */
  query: string;
  /** the hits for `query`, once they've answered */
  hits: PeopleSearch | null;
  /** the selected person's page, by their key (null: not read yet, or nobody selected) */
  page: PersonPage | null;
  /** the person whose page is being read (their key and an address as seen), until it answers */
  reading: { key: string; email: string } | null;
  /** the list's last read failed (what was shown stays; it says so, with a way to try again) */
  failed: boolean;
  /** the page that didn't come, to try again */
  pageFailed: { key: string; email: string } | null;
  /**
   * The person being worked on, kept where their row was in Open while they stay selected: an act that changes what's
   * open with them (their last item done: nothing open) never moves the row from under the user. Let go on another person.
   */
  held: { key: string; index: number } | null;
  /**
   * The rows' "Last email" (nothing open with them): each one's last conversation's date by key, as their page's head says it
   * (0: none), read for the rows drawn (`askLastEmails`); `lastRev` moves when mail changes, and the drawn rows ask again.
   */
  lastEmails: ReadonlyMap<string, number>;
  lastRev: number;
  /** Later's "Pick a date…": the item it's for, from a person's page or the card (`PersonLaterDialog`) */
  laterPick: { item: PersonItem; via: "page" | "card" } | null;
}

export const usePeople = create<PeopleState>(() => ({ list: null, query: "", hits: null, page: null, reading: null, failed: false, pageFailed: null, held: null, lastEmails: new Map(), lastRev: 0, laterPick: null }));

/** One row of People's list: a heading, or a person (with what's open, or what the index knows of them). */
export type PeopleRow =
  | { kind: "heading"; id: "open" | "everyone" | "hits"; count: number }
  | { kind: "person"; id: string; key: string; email: string; name: string; last: number; open: PersonOpen | null; openCount: number };

/**
 * The list's rows: the hits while something is typed (one section, no heading), else Open then Everyone, each under its
 * heading, a heading only over rows. An Everyone entry's row is made once (the same object while the entry is), so a
 * reload that kept Everyone draws none of its rows again.
 */
export function peopleRows(list: PeopleList | null, query: string, hits: PeopleSearch | null, held: PeopleState["held"] = null): PeopleRow[] {
  const rows: PeopleRow[] = [];
  if (query.trim()) {
    if (!hits) return rows;
    // a hit reads as its row does in the list: what's open with them, else the address it matched on
    const open = new Map((list?.open ?? []).map((p) => [p.key, p]));
    for (const h of hits.hits) {
      const o = open.get(h.key) ?? null;
      rows.push({ kind: "person", id: h.key, key: h.key, email: h.email, name: h.name || h.email, last: h.last, open: o, openCount: o?.items.length ?? h.open });
    }
    return rows;
  }
  if (!list) return rows;
  const openRows: PeopleRow[] = list.open.map((p) => ({ kind: "person", id: p.key, key: p.key, email: p.email, name: p.name, last: 0, open: p, openCount: p.items.length }));
  const open = new Set(list.open.map((p) => p.key));
  // the person being worked on stays where their row was (with nothing open now, it says so)
  if (held) {
    const at = openRows.findIndex((r) => r.id === held.key);
    const entry = list.everyone?.find((p) => p.key === held.key);
    const row = at >= 0 ? openRows.splice(at, 1)[0] : entry ? ({ kind: "person", id: entry.key, key: entry.key, email: entry.email, name: entry.name || entry.email, last: entry.last, open: { key: entry.key, email: entry.email, name: entry.name || entry.email, items: [], since: null }, openCount: 0 } as PeopleRow) : null;
    if (row) {
      openRows.splice(Math.min(held.index, openRows.length), 0, row);
      open.add(held.key);
    }
  }
  if (openRows.length) {
    // (who has only what's put off sits at Open's end, not counted with it)
    rows.push({ kind: "heading", id: "open", count: openNow(list) });
    rows.push(...openRows);
  }
  // Everyone holds the open people too, at their places (so one whose last item goes falls in there): left out here
  const everyone: PeopleRow[] = [];
  for (const p of list.everyone ?? []) if (!open.has(p.key)) everyone.push(entryRow(p));
  if (everyone.length) {
    rows.push({ kind: "heading", id: "everyone", count: everyone.length });
    rows.push(...everyone);
  }
  return rows;
}

const entryRows = new WeakMap<PersonEntry, PeopleRow>();
function entryRow(p: PersonEntry & { key: string }): PeopleRow {
  let row = entryRows.get(p);
  if (!row) entryRows.set(p, (row = { kind: "person", id: p.key, key: p.key, email: p.email, name: p.name || p.email, last: p.last, open: null, openCount: 0 }));
  return row;
}

/** How many have something open now (Open's count: those with only what's put off with Later aren't in it). */
export const openNow = (list: PeopleList | null): number => list?.open.filter((p) => p.since !== null).length ?? 0;

/** The index's state as the list shows it: Everyone's line while it isn't there. */
export const indexOf = (list: PeopleList | null): PeopleIndexState => list?.index ?? "warming";

/** folded for matching: lower case, accents off (one character for one, so places stay the text's) */
const fold = (s: string): string => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/**
 * What a search's words matched in a name or an address, as the search matches them: each word at the start of a word of
 * it (a name's, the address's local part or domain). For `Marked`: the text in parts, the matched ones marked.
 */
export function matchedParts(text: string, query: string): { text: string; hit: boolean }[] | null {
  const words = query.split(/[\s,;<>"()'.+_@-]+/).map(fold).filter(Boolean);
  if (!words.length) return null;
  const chars = [...text];
  const folded = chars.map((c) => fold(c).charAt(0) || c);
  const hit = Array.from({ length: chars.length }, () => false);
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && !/[\s@._+\-(),]/.test(chars[i - 1]!)) continue;
    for (const w of words) {
      const wc = [...w];
      if (wc.every((c, k) => folded[i + k] === c)) for (let k = 0; k < wc.length; k++) hit[i + k] = true;
    }
  }
  if (!hit.some(Boolean)) return null;
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === hit[i]) last.text += chars[i];
    else parts.push({ text: chars[i]!, hit: hit[i]! });
  }
  return parts;
}
