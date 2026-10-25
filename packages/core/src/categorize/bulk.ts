import type { Reason } from "../types";
import type { FilterRule } from "../rules/schema";

/** Counts above this show as "1 000+": a chip never pays for an exact count of a huge set. */
export const COUNT_CAP = 1000;

/** What a bulk categorization covers. Every scope leaves out threads already filed, trash/spam and threads the user removed. */
export type CategorizeScope =
  | { kind: "sender"; email: string }
  | { kind: "domain"; domain: string }
  | { kind: "list"; listId: string }
  /** search language, e.g. `"factura" "uber" from:@uber.com` */
  | { kind: "query"; query: string };

export interface QuickActions {
  sender: { email: string; name: string } | null;
  domain: string | null;
  list: string | null;
  /** distinguishing words, best first; the first two come preselected */
  terms: { term: string; preselected: boolean }[];
  /** "Siempre → filtro": the strongest shared identity, adding to the category */
  filterDraft: { name: string; rule: FilterRule } | null;
}

export interface Prediction {
  categoryId: number;
  p: number;
  decision: "auto" | "suggest" | "none";
  reasons: Reason[];
}

export interface CategoryModelStats {
  categoryId: number;
  /** threads the user filed there (the model's positive examples) */
  examples: number;
  autoApply: boolean;
  kept: number;
  reverted: number;
  /** kept / (kept + reverted), null before any outcome */
  autoPrecision: number | null;
  /** the safety valve stopped auto-applying */
  paused: boolean;
  pendingSuggestions: number;
}

/** The search-language query for "Sobre: …": quoted words, minus what is already filed. */
export function termsQuery(terms: readonly string[], categoryName: string): string {
  const category = /\s/.test(categoryName) ? `"${categoryName.replaceAll('"', "")}"` : categoryName;
  return [...terms.map((t) => `"${t.replaceAll('"', "")}"`), `-category:${category}`].join(" ");
}
