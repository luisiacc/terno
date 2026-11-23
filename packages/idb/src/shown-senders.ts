import { addressKey, SHOWN_SENDERS_MAX, type DatedMute, type ShownSender } from "@terno/core";
import type { ShownAdded, ShownRemoved } from "@terno/store";
import { requeueSender } from "./facts";
import { T, type Ctx, type R } from "./mail";

/** Plan 240 on IndexedDB, like SQL's (packages/db/src/shown-senders.ts). */

const NAME_MAX = 200;

const toShown = (r: R): ShownSender => ({ id: r.id, key: r.key, email: r.email, name: r.name, at: r.created_at });

export const listShown = (c: Ctx): ShownSender[] => [...T(c, "shown_senders").all()].map(toShown).sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** The keys, for a walk (at most `SHOWN_SENDERS_MAX`). */
export const shownKeys = (c: Ctx): Set<string> => new Set([...T(c, "shown_senders").all()].map((r) => r.key as string));

/** As SQL's: the entry, the sender's own mute gone with it, their threads' facts recomputed, in one command. */
export function addShown(c: Ctx, s: Omit<ShownSender, "key">): ShownAdded {
  const key = addressKey(s.email);
  if (!key.includes("@")) throw new TypeError("not an address");
  const shown = T(c, "shown_senders");
  if (shown.has(key)) return { added: null, unmuted: null, threadIds: [] };
  if (shown.size >= SHOWN_SENDERS_MAX) return "full";
  const entry: ShownSender = { id: s.id, key, email: s.email.trim(), name: s.name.trim().slice(0, NAME_MAX), at: s.at };
  shown.insert({ key, id: entry.id, email: entry.email, name: entry.name, created_at: entry.at });
  const mute = T(c, "dated_mutes").delete("sender", key);
  const unmuted: DatedMute | null = mute ? { on: "sender", key, name: mute.name, at: mute.created_at } : null;
  const touched = new Set<number>();
  requeueSender(c.db, key, touched);
  return { added: entry, unmuted, threadIds: [...touched] };
}

/** As SQL's: only that `id`'s entry when one is named. */
export function removeShown(c: Ctx, key: string, id?: string): ShownRemoved {
  const shown = T(c, "shown_senders");
  const r = shown.get(key);
  if (!r || (id !== undefined && r.id !== id)) return { removed: null, threadIds: [] };
  shown.delete(key);
  const touched = new Set<number>();
  requeueSender(c.db, key, touched);
  return { removed: toShown(r), threadIds: [...touched] };
}

/** As SQL's: written to, or shown. */
export const trustedSenders = (c: Ctx, keys: readonly string[]): Set<string> => {
  const correspondents = T(c, "correspondents");
  const shown = T(c, "shown_senders");
  return new Set([...new Set(keys)].filter((key) => correspondents.get(key)?.written === 1 || shown.has(key)));
};
