import type { PeopleIndexState, PeopleList, PeopleSearch, PersonEntry, PersonOpen, PersonPage } from "@terno/core";
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
}

export const usePeople = create<PeopleState>(() => ({ list: null, query: "", hits: null, page: null, reading: null }));

/** One row of People's list: a heading, or a person (with what's open, or what the index knows of them). */
export type PeopleRow =
  | { kind: "heading"; id: "open" | "everyone" | "hits"; count: number }
  | { kind: "person"; id: string; key: string; email: string; name: string; last: number; open: PersonOpen | null; openCount: number };

/**
 * The list's rows: the hits while something is typed (one section, no heading), else Open then Everyone, each under its
 * heading, a heading only over rows. `keyOf` is `personKey` (passed in: this stays pure).
 */
export function peopleRows(list: PeopleList | null, query: string, hits: PeopleSearch | null, keyOf: (email: string) => string): PeopleRow[] {
  const rows: PeopleRow[] = [];
  if (query.trim()) {
    if (!hits) return rows;
    // a hit says the address it matched on, and how many things are open (its page says which)
    for (const h of hits.hits) rows.push({ kind: "person", id: h.key, key: h.key, email: h.email, name: h.name || h.email, last: h.last, open: null, openCount: h.open });
    return rows;
  }
  if (!list) return rows;
  if (list.open.length) {
    rows.push({ kind: "heading", id: "open", count: list.open.length });
    for (const p of list.open) rows.push({ kind: "person", id: p.key, key: p.key, email: p.email, name: p.name, last: 0, open: p, openCount: p.items.length });
  }
  if (list.everyone.length) {
    rows.push({ kind: "heading", id: "everyone", count: list.everyone.length });
    for (const p of list.everyone) rows.push(entryRow(p, keyOf(p.email)));
  }
  return rows;
}

const entryRow = (p: PersonEntry, key: string): PeopleRow => ({ kind: "person", id: key, key, email: p.email, name: p.name || p.email, last: p.last, open: null, openCount: 0 });

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
  const hit = new Array<boolean>(chars.length).fill(false);
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
