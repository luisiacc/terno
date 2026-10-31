import type { Snippet, SnippetFields } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { registerUndo, snack, type Undo } from "./snack";

/**
 * Plan 89: the snippets, loaded on first need (the palette, ⌘;, Settings) and
 * kept; each open lists them again (a local call), so another window's edits
 * show. Saves go one at a time per snippet, the latest content winning.
 */

export const useSnippets = create<{ list: Snippet[] | null }>(() => ({ list: null }));

/** A new snippet's id (made here, so every autosave of a new one is the same snippet). */
export function newSnippetId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  return `s_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => chars[b & 63]).join("")}`;
}

const byName = (a: Snippet, b: Snippet) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.createdAt - b.createdAt;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let listing: Promise<Snippet[]> | null = null;
/** Lists them again (concurrent calls share one). */
export function reloadSnippets(): Promise<Snippet[]> {
  listing ??= client.call("snippets.list", {}).then(
    (list) => {
      listing = null;
      useSnippets.setState({ list });
      return list;
    },
    (error: unknown) => {
      listing = null;
      throw error;
    },
  );
  return listing;
}

/** On opening something that shows them: lists them (a failure keeps what was there, and says so only where nothing was). */
export function loadSnippets(): void {
  reloadSnippets().catch((error: unknown) => {
    if (useSnippets.getState().list === null) {
      useSnippets.setState({ list: [] });
      snack.error(errorText(error));
    }
  });
}

function put(s: Snippet): void {
  const list = useSnippets.getState().list ?? [];
  useSnippets.setState({ list: [...list.filter((x) => x.id !== s.id), s].sort(byName) });
}
function drop(id: string): void {
  const list = useSnippets.getState().list;
  if (list) useSnippets.setState({ list: list.filter((x) => x.id !== id) });
}

// ── saving: one in flight per snippet, the rest coalesced

export type SaveStatus = "idle" | "saving" | "saved" | "failed" | "conflict";
export const useSaveStatus = create<Record<string, SaveStatus>>(() => ({}));
const setStatus = (id: string, status: SaveStatus) => useSaveStatus.setState({ [id]: status });

interface Session {
  /** the updatedAt the next save is based on (null: not created yet) */
  base: number | null;
  /** what's still to save */
  pending: SnippetFields | null;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** "Keep mine": the next save goes over another window's */
  force: boolean;
  /** deleted: nothing more is saved */
  closed: boolean;
}
const sessions = new Map<string, Session>();
/** how long after the last change a snippet saves */
export const SAVE_DELAY_MS = 500;

/** The editor opening a snippet: its saves are based on this version (null for a new one). */
export function beginEdit(id: string, base: number | null): void {
  const s = sessions.get(id);
  if (s && !s.closed && (s.pending || s.inFlight)) return; // its own unsaved work is still the newest
  sessions.set(id, { base, pending: null, inFlight: null, timer: null, force: false, closed: false });
  setStatus(id, "idle");
}

/** A change: saved SAVE_DELAY_MS after the last one (or now with `flush`). */
export function queueSave(id: string, fields: SnippetFields, flush = false): void {
  const s = sessions.get(id);
  if (!s || s.closed) return;
  s.pending = fields;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  if (flush) return pump(id);
  s.timer = setTimeout(() => {
    s.timer = null;
    pump(id);
  }, SAVE_DELAY_MS);
}

/** Leaving the editor (back, another tab, Settings closing): what's waiting saves now, owned by this module, not the editor. */
export function flushSave(id: string): void {
  const s = sessions.get(id);
  if (!s?.timer) return;
  clearTimeout(s.timer);
  s.timer = null;
  pump(id);
}

function pump(id: string): void {
  const s = sessions.get(id);
  const status = useSaveStatus.getState()[id];
  if (!s || s.closed || s.inFlight || !s.pending || status === "conflict") return;
  const fields = s.pending;
  s.pending = null;
  setStatus(id, "saving");
  s.inFlight = client.call("snippets.save", { ...fields, id, base: s.base, ...(s.force ? { force: true } : {}) }).then(
    (saved) => {
      s.inFlight = null;
      s.base = saved.updatedAt;
      s.force = false;
      put(saved);
      setStatus(id, s.pending ? "saving" : "saved");
      pump(id);
    },
    (error: unknown) => {
      s.inFlight = null;
      // kept: the newest content waits for a retry (or "Keep mine")
      s.pending ??= fields;
      setStatus(id, (error as { code?: string } | null)?.code === "STALE" ? "conflict" : "failed");
    },
  );
}

/** "Retry" after a failed save. */
export function retrySave(id: string): void {
  setStatus(id, "idle");
  pump(id);
}

/** "Keep mine": saves this editor's content over another window's change. */
export function keepMine(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.force = true;
  setStatus(id, "idle");
  pump(id);
}

/** "Load theirs": drops this editor's unsaved content; the stored snippet (or null, deleted elsewhere). */
export async function loadTheirs(id: string): Promise<Snippet | null> {
  const s = sessions.get(id);
  if (s) {
    s.pending = null;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }
  const theirs = (await reloadSnippets()).find((x) => x.id === id) ?? null;
  if (s) s.base = theirs?.updatedAt ?? null;
  setStatus(id, theirs ? "saved" : "idle");
  return theirs;
}

/**
 * Deletes it at once (after its save in flight); its Undo puts the same
 * snippet back. Returns that Undo (Settings shows it in its list: a snack
 * would sit under the dialog), or null when the delete failed.
 */
export async function deleteSnippet(snippet: Snippet): Promise<Undo | null> {
  const s = sessions.get(snippet.id);
  let pending: SnippetFields | null = null;
  if (s) {
    s.closed = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    pending = s.pending;
    s.pending = null;
    await s.inFlight;
  }
  // what was being typed comes back with Undo too
  const latest: Snippet = { ...snippet, ...useSnippets.getState().list?.find((x) => x.id === snippet.id), ...pending };
  try {
    await client.call("snippets.delete", { id: snippet.id });
  } catch (error) {
    if (s) {
      s.closed = false;
      s.pending ??= pending;
    }
    snack.error(errorText(error));
    return null;
  }
  sessions.delete(snippet.id);
  drop(snippet.id);
  return registerUndo(async () => {
    const { id, name, bodyHtml, bodyText, subject, to, cc, bcc } = latest;
    put(await client.call("snippets.save", { id, name, bodyHtml, bodyText, subject, to, cc, bcc, base: null }));
  });
}

/** A new snippet straight from content (Save as snippet…): created now, so the editor opens on it. */
export async function createSnippet(id: string, fields: SnippetFields): Promise<Snippet> {
  const saved = await client.call("snippets.save", { ...fields, id, base: null });
  put(saved);
  return saved;
}

/** Test seam: forget every session (jsdom tests). */
export function resetSnippetsForTests(): void {
  for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer);
  sessions.clear();
  useSnippets.setState({ list: null });
  useSaveStatus.setState({}, true);
}
