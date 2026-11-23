import { addressKey, SHOWN_SENDERS_MAX, type DatedMute, type ShownSender } from "@terno/core";
import type { ShownAdded, ShownRemoved } from "@terno/store";
import { requeueSender } from "./facts";
import type { Db } from "./sqlite";

/** Plan 240 on SQLite (v76): the senders always shown in What matters. See packages/store/src/today.ts. */

const NAME_MAX = 200;

type Raw = { key: string; id: string; email: string; name: string; created_at: number };
const toShown = (r: Raw): ShownSender => ({ id: r.id, key: r.key, email: r.email, name: r.name, at: r.created_at });

export const listShown = (db: Db): ShownSender[] => db.all<Raw>("SELECT * FROM shown_senders ORDER BY created_at DESC, key").map(toShown);

/** The keys, for a walk (at most `SHOWN_SENDERS_MAX`). */
export const shownKeys = (db: Db): Set<string> => new Set(db.all<{ key: string }>("SELECT key FROM shown_senders").map((r) => r.key));

/**
 * One command: the entry (null if the sender is shown already), the sender's own mute gone with it (one sender is never
 * both), and their threads' facts recomputed (those done here in `threadIds`; past the inline bound, the facts' job).
 */
export function addShown(db: Db, s: Omit<ShownSender, "key">): ShownAdded {
  const key = addressKey(s.email);
  if (!key.includes("@")) throw new TypeError("not an address");
  return db.tx((): ShownAdded => {
    if (db.get("SELECT 1 FROM shown_senders WHERE key = ?", key)) return { added: null, unmuted: null, threadIds: [] };
    if (db.get<{ n: number }>("SELECT count(*) AS n FROM shown_senders")!.n >= SHOWN_SENDERS_MAX) return "full";
    const entry: ShownSender = { id: s.id, key, email: s.email.trim(), name: s.name.trim().slice(0, NAME_MAX), at: s.at };
    db.run("INSERT INTO shown_senders (key, id, email, name, created_at) VALUES (?, ?, ?, ?, ?)", key, entry.id, entry.email, entry.name, entry.at);
    const mute = db.get<{ name: string; created_at: number }>("SELECT name, created_at FROM dated_mutes WHERE target = 'sender' AND key = ?", key);
    if (mute) db.run("DELETE FROM dated_mutes WHERE target = 'sender' AND key = ?", key);
    const unmuted: DatedMute | null = mute ? { on: "sender", key, name: mute.name, at: mute.created_at } : null;
    const touched = new Set<number>();
    requeueSender(db, key, touched);
    return { added: entry, unmuted, threadIds: [...touched] };
  });
}

/** The entry gone (only that `id`'s, when one is named: an Undo never removes a later Show), the facts recomputed. */
export function removeShown(db: Db, key: string, id?: string, mute?: { name: string; at: number }): ShownRemoved {
  return db.tx((): ShownRemoved => {
    const r = db.get<Raw>("SELECT * FROM shown_senders WHERE key = ?", key);
    if (!r || (id !== undefined && r.id !== id)) return { removed: null, threadIds: [] };
    db.run("DELETE FROM shown_senders WHERE key = ?", key);
    // Show's Undo: the mute it ended, back as it was, whatever the bound (Codex code review)
    if (mute) db.run("INSERT OR IGNORE INTO dated_mutes (target, key, name, created_at) VALUES ('sender', ?, ?, ?)", key, mute.name, mute.at);
    const touched = new Set<number>();
    requeueSender(db, key, touched);
    return { removed: toShown(r), threadIds: [...touched] };
  });
}

/** The senders among these (`addressKey`s) the guard trusts: written to, or shown (plan 240). */
export const trustedSenders = (db: Db, keys: readonly string[]): Set<string> =>
  new Set(
    [...new Set(keys)].filter(
      (key) => db.get<{ written: number }>("SELECT written FROM correspondents WHERE email = ?", key)?.written === 1 || db.get("SELECT 1 FROM shown_senders WHERE key = ?", key) !== undefined,
    ),
  );
