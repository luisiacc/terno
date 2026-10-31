import { snippetSchema, snippetsBytes, SNIPPETS_BYTES_MAX, SNIPPETS_MAX, type Snippet, type SnippetFields } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { SettingsStore } from "./settings";

/**
 * Plan 89: snippets, one array under the settings key "snippets" (both
 * stores have it; no migration). Every write is one read-modify-write, and
 * the budget keeps the value small to parse and write.
 */
const KEY = "snippets";

const byName = (a: Snippet, b: Snippet) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.createdAt - b.createdAt;

/** What is stored, keeping only valid items (a damaged value lists what it can). */
function readList(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return [];
  const out: Snippet[] = [];
  for (const item of raw) {
    const r = snippetSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

function withinBudget(list: Snippet[]): void {
  if (list.length > SNIPPETS_MAX) throw new RpcError("BAD_REQUEST", L("snippets.error.tooMany", { max: SNIPPETS_MAX }));
  if (snippetsBytes(list) > SNIPPETS_BYTES_MAX) throw new RpcError("BAD_REQUEST", L("snippets.error.tooLarge"));
}

export async function listSnippets(store: SettingsStore): Promise<Snippet[]> {
  return readList(await store.settings.get<unknown>(KEY, [])).sort(byName);
}

export interface SaveSnippet extends SnippetFields {
  id: string;
  /** the updatedAt the edit started from; null creates (or restores a deleted one) */
  base: number | null;
  /** save over whatever is there (the editor's "Keep mine") */
  force?: boolean;
}

export async function saveSnippet(store: SettingsStore, p: SaveSnippet, now: number): Promise<Snippet> {
  return store.settings.update<unknown, Snippet>(KEY, [], (raw) => {
    const list = readList(raw);
    const at = list.findIndex((s) => s.id === p.id);
    const stored = at === -1 ? undefined : list[at];
    if (!p.force) {
      // created twice is the same snippet saved again (a retry); an update needs the version it was based on
      if (p.base === null && stored) throw new RpcError("STALE", L("snippets.error.changed"));
      if (p.base !== null && (!stored || stored.updatedAt !== p.base)) throw new RpcError("STALE", L("snippets.error.changed"));
    }
    // a strictly later version, so an editor's next base always tells its own save from another window's
    const updatedAt = Math.max(now, (stored?.updatedAt ?? 0) + 1);
    const next: Snippet = { id: p.id, name: p.name, bodyHtml: p.bodyHtml, bodyText: p.bodyText, subject: p.subject, to: p.to, cc: p.cc, bcc: p.bcc, createdAt: stored?.createdAt ?? now, updatedAt };
    const value = stored ? list.map((s, i) => (i === at ? next : s)) : [...list, next];
    withinBudget(value);
    return { value, result: next };
  });
}

export async function deleteSnippet(store: SettingsStore, id: string): Promise<void> {
  await store.settings.update<unknown, void>(KEY, [], (raw) => ({ value: readList(raw).filter((s) => s.id !== id), result: undefined }));
}

/** An import's snippets: those whose id and name (any case) aren't here, while the budget allows. Returns how many went in. */
export async function importSnippets(store: SettingsStore, items: readonly Snippet[]): Promise<number> {
  return store.settings.update<unknown, number>(KEY, [], (raw) => {
    const list = readList(raw);
    const ids = new Set(list.map((s) => s.id));
    const names = new Set(list.map((s) => s.name.toLocaleLowerCase()));
    let added = 0;
    let bytes = snippetsBytes(list);
    for (const s of items) {
      if (ids.has(s.id) || names.has(s.name.toLocaleLowerCase())) continue;
      // each item adds itself and a comma to the array's JSON
      const more = snippetsBytes([s]) - 1;
      if (list.length + 1 > SNIPPETS_MAX || bytes + more > SNIPPETS_BYTES_MAX) break;
      bytes += more;
      list.push(s);
      ids.add(s.id);
      names.add(s.name.toLocaleLowerCase());
      added++;
    }
    return { value: list, result: added };
  });
}
