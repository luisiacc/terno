import { isFolder } from "./folders";
import type { ImapLocation, ImapLocationStore, ProviderStore } from "@terno/store";
import { getSetting } from "./repos";
import { sqlFlags } from "./flag-intents";
import type { FlagSnapshotRequest } from "@terno/store";
import { placeholders, type Db } from "./sqlite";

/** One account's provider-side reads and IMAP identity, as the providers used to run them on the database. */
export class SqlProviderStore implements ProviderStore {
  readonly locations: ImapLocationStore;
  async pendingFlagSnapshots(request: FlagSnapshotRequest) { return sqlFlags(this.db).snapshots(this.accountId, request); }

  constructor(
    private readonly db: Db,
    private readonly accountId: number,
  ) {
    this.locations = new SqlImapLocations(db, accountId);
  }

  async messageByProviderId(providerMsgId: string) {
    const r = this.db.get<{ id: number; subject: string; from_email: string }>(
      "SELECT id, subject, from_email FROM messages WHERE account_id = ? AND provider_msg_id = ?",
      this.accountId,
      providerMsgId,
    );
    return r ? { id: r.id, subject: r.subject, fromEmail: r.from_email } : null;
  }

  async syncedMessages() {
    return this.db
      .all<{ id: number; provider_msg_id: string; date: number }>(
        "SELECT id, provider_msg_id, date FROM messages WHERE account_id = ? AND provider_msg_id NOT LIKE 'local:%'",
        this.accountId,
      )
      .map((r) => ({ id: r.id, providerMsgId: r.provider_msg_id, date: r.date }));
  }

  async pendingAttachmentBodies(limit: number) {
    return this.db.all<{ id: number; providerMsgId: string }>("SELECT id, provider_msg_id AS providerMsgId FROM messages WHERE account_id = ? AND attachments_captured = 0 AND provider_msg_id IS NOT NULL AND provider_msg_id NOT LIKE 'local:%' ORDER BY id LIMIT ?", this.accountId, Math.max(0, Math.min(50, limit)));
  }

  async pendingBodies(limit: number) {
    return this.db.all<{ id: number; mailbox: string; uid: number; uidvalidity: number }>(
      `SELECT m.id, l.mailbox, l.uid, l.uidvalidity FROM messages m INDEXED BY messages_capture_pending JOIN message_locations l ON l.message_id = m.id
       AND l.mailbox = (SELECT mailbox FROM message_locations WHERE message_id = m.id ORDER BY mailbox LIMIT 1)
       WHERE m.account_id = ? AND ((m.body_state != 'full' AND m.attachments_captured != 2) OR m.attachments_captured = 0) ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      this.accountId,
      limit,
    );
  }

  async countPendingBodies() {
    return this.db.get<{ c: number }>("SELECT count(*) c FROM messages INDEXED BY messages_capture_pending WHERE account_id = ? AND ((body_state != 'full' AND attachments_captured != 2) OR attachments_captured = 0)", this.accountId)!.c;
  }

  async providerIds(messageIds: readonly number[]) {
    const out = new Map<number, string | null>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      for (const r of this.db.all<{ id: number; p: string | null }>(`SELECT id, provider_msg_id AS p FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)) {
        out.set(r.id, r.p);
      }
    }
    return out;
  }

  async setting<T>(key: string): Promise<T | null> {
    return getSetting<T | null>(this.db, key, null);
  }
}

/** Rows a reset forgets per transaction (each well inside the backend's slice). */
const RESET_SLICE = 1000;

class SqlImapLocations implements ImapLocationStore {
  constructor(
    private readonly db: Db,
    private readonly accountId: number,
  ) {}

  /**
   * plan 68: a location in a listed folder decides membership, kept in the same transaction and incrementally
   * (Codex R10: refolding the whole thread per location was quadratic in a long conversation): a new location adds
   * its thread's row; one that goes takes it only when no other message of the thread is still there.
   */
  private located(messageIds: readonly number[], mailbox: string, added: boolean) {
    if (!messageIds.length || !isFolder(this.db, this.accountId, mailbox)) return;
    for (const id of messageIds) {
      if (added) {
        this.db.run(
          `INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
           SELECT t.id, t.account_id, ?, t.last_date, t.unread_count > 0 FROM messages m JOIN threads t ON t.id = m.thread_id
           WHERE m.id = ? AND m.is_trash = 0 AND m.is_spam = 0`,
          mailbox,
          id,
        );
      } else {
        this.db.run(
          `DELETE FROM thread_folders WHERE folder = ? AND thread_id = (SELECT thread_id FROM messages WHERE id = ?)
             AND NOT EXISTS (SELECT 1 FROM messages o JOIN message_locations l ON l.message_id = o.id
                             WHERE o.thread_id = thread_folders.thread_id AND l.mailbox = ? AND o.is_trash = 0 AND o.is_spam = 0)`,
          mailbox,
          id,
          mailbox,
        );
      }
    }
  }

  async upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) {
    this.db.tx(() => {
      // a known location (new flags, a new UID) moves no membership
      const known = this.db.get("SELECT 1 FROM message_locations WHERE message_id = ? AND mailbox = ?", messageId, mailbox) !== undefined;
      this.write(messageId, mailbox, uidvalidity, uid, flags);
      if (!known) this.located([messageId], mailbox, true);
    });
  }

  private write(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) {
    this.db.run(
      `INSERT INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) VALUES (?,?,?,?,?,?)
       ON CONFLICT (message_id, mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, uid = excluded.uid, flags = excluded.flags`,
      messageId,
      this.accountId,
      mailbox,
      uidvalidity,
      uid,
      JSON.stringify(flags),
    );
  }

  async remove(messageId: number, mailbox: string) {
    this.db.tx(() => {
      this.db.run("DELETE FROM message_locations WHERE message_id = ? AND mailbox = ?", messageId, mailbox);
      this.located([messageId], mailbox, false);
    });
  }

  async removeMany(messageIds: readonly number[], mailbox: string) {
    const threads = new Set<number>();
    for (let i = 0; i < messageIds.length; i += RESET_SLICE) {
      const chunk = messageIds.slice(i, i + RESET_SLICE);
      this.db.tx(() => {
        for (const r of this.db.all<{ thread_id: number }>(`SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)) threads.add(r.thread_id);
        this.db.run(`DELETE FROM message_locations WHERE mailbox = ? AND message_id IN (${placeholders(chunk.length)})`, mailbox, ...chunk);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!isFolder(this.db, this.accountId, mailbox)) return;
    // then each thread's row, once all its locations are gone: it goes only when none of its messages is still there,
    // decided where it's deleted (Codex R36: a message made eligible meanwhile, "Not spam", kept its row's place):
    // - a short thread (its message count from the thread row) in a batch's own transaction, the check inside the
    //   delete, batches of at most RESET_SLICE messages in all;
    // - a long one a page at a time from where the last page ended (Codex R34), deleted only if nothing was written
    //   since its scan began (total_changes: one writer, this connection), else scanned again, at last checked inside
    //   the delete itself;
    // a few milliseconds a turn across threads (Codex R35)
    let since = performance.now();
    const breathe = async () => {
      if (performance.now() - since < 4) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      since = performance.now();
    };
    const stillThere = `EXISTS (SELECT 1 FROM messages o JOIN message_locations l ON l.message_id = o.id
                               WHERE o.thread_id = thread_folders.thread_id AND l.mailbox = ? AND o.is_trash = 0 AND o.is_spam = 0)`;
    const conditional = (ids: readonly number[]) =>
      this.db.tx(() => this.db.run(`DELETE FROM thread_folders WHERE folder = ? AND thread_id IN (${placeholders(ids.length)}) AND NOT ${stillThere}`, mailbox, ...ids, mailbox));
    // a long thread being decided is watched (temporary triggers, this connection's): a location written for one of
    // its messages, or one of them changing spam, trash or thread, marks it (Codex R37: any write anywhere moved
    // total_changes, and three scans in a row fell back to the whole thread in one statement)
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS expunge_watch (thread_id INTEGER PRIMARY KEY, dirty INTEGER NOT NULL DEFAULT 0);
      CREATE TEMP TRIGGER IF NOT EXISTS expunge_watch_loc_in AFTER INSERT ON message_locations BEGIN
        UPDATE expunge_watch SET dirty = 1 WHERE thread_id = (SELECT thread_id FROM messages WHERE id = NEW.message_id);
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS expunge_watch_loc_up AFTER UPDATE ON message_locations BEGIN
        UPDATE expunge_watch SET dirty = 1 WHERE thread_id = (SELECT thread_id FROM messages WHERE id = NEW.message_id);
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS expunge_watch_msg AFTER UPDATE OF is_spam, is_trash, thread_id ON messages BEGIN
        UPDATE expunge_watch SET dirty = 1 WHERE thread_id IN (NEW.thread_id, OLD.thread_id);
      END;`);
    let batch: number[] = [];
    let batchMessages = 0;
    const flush = () => {
      if (batch.length) conditional(batch);
      batch = [];
      batchMessages = 0;
    };
    const sizes = new Map<number, number>();
    const all = [...threads];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      for (const r of this.db.all<{ id: number; n: number }>(`SELECT id, message_count AS n FROM threads WHERE id IN (${placeholders(chunk.length)})`, ...chunk)) sizes.set(r.id, r.n);
      await breathe();
    }
    for (const thread of all) {
      const n = sizes.get(thread) ?? 0;
      if (n <= RESET_SLICE) {
        if (batchMessages + n > RESET_SLICE) flush();
        batch.push(thread);
        batchMessages += n;
        await breathe();
        continue;
      }
      let decided = false;
      for (let attempt = 0; attempt < 3 && !decided; attempt++) {
        this.db.run("INSERT OR REPLACE INTO expunge_watch (thread_id, dirty) VALUES (?, 0)", thread);
        let after = { date: Number.NEGATIVE_INFINITY, id: 0 };
        let here = false;
        for (;;) {
          const page = this.db.all<{ id: number; date: number; here: number }>(
            `SELECT o.id, o.date, (o.is_trash = 0 AND o.is_spam = 0 AND EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = o.id AND l.mailbox = ?)) AS here
               FROM messages o INDEXED BY messages_thread WHERE o.thread_id = ? AND (o.date, o.id) > (?, ?) ORDER BY o.date, o.id LIMIT ?`,
            mailbox,
            thread,
            after.date,
            after.id,
            RESET_SLICE,
          );
          if (page.some((r) => r.here === 1)) {
            here = true;
            break;
          }
          if (page.length < RESET_SLICE) break;
          after = { date: page.at(-1)!.date, id: page.at(-1)!.id };
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (here) decided = true;
        else if (this.db.get<{ dirty: number }>("SELECT dirty FROM expunge_watch WHERE thread_id = ?", thread)?.dirty === 0) {
          // nothing that could put one back written since the scan began: still none there, deleted in this same turn
          this.db.tx(() => this.db.run("DELETE FROM thread_folders WHERE thread_id = ? AND folder = ?", thread, mailbox));
          decided = true;
        }
      }
      this.db.run("DELETE FROM expunge_watch WHERE thread_id = ?", thread);
      // (a thread changing under all three scans keeps its row: shown a while longer, never a whole thread in one go)
      await breathe();
    }
    flush();
  }

  async setFlags(messageId: number, mailbox: string, flags: string) {
    this.db.run("UPDATE message_locations SET flags = ? WHERE message_id = ? AND mailbox = ?", flags, messageId, mailbox);
  }

  async of(messageIds: readonly number[]): Promise<ImapLocation[]> {
    const out: ImapLocation[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      out.push(
        ...this.db.all<ImapLocation>(
          `SELECT message_id, mailbox, uid, uidvalidity, flags FROM message_locations WHERE message_id IN (${placeholders(chunk.length)})`,
          ...chunk,
        ),
      );
    }
    return out;
  }

  async at(mailbox: string, uidvalidity: number, uid: number) {
    return (
      this.db.get<{ message_id: number }>(
        "SELECT message_id FROM message_locations WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?",
        this.accountId,
        mailbox,
        uidvalidity,
        uid,
      )?.message_id ?? null
    );
  }

  async get(messageId: number, mailbox: string) {
    return this.db.get<{ uid: number; uidvalidity: number; flags: string }>(
      "SELECT uid, uidvalidity, flags FROM message_locations WHERE message_id = ? AND mailbox = ?",
      messageId,
      mailbox,
    ) ?? null;
  }

  async count(messageId: number) {
    return this.db.get<{ c: number }>("SELECT count(*) AS c FROM message_locations WHERE message_id = ?", messageId)!.c;
  }

  async inMailboxPage(mailbox: string, uidvalidity: number, afterUid: number, limit: number) {
    return this.db.all<{ message_id: number; uid: number; flags: string }>(
      "SELECT message_id, uid, flags FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid > ? ORDER BY uid LIMIT ?",
      this.accountId,
      mailbox,
      uidvalidity,
      afterUid,
      limit,
    );
  }

  async inMailbox(mailbox: string, uidvalidity: number) {
    return this.db.all<{ message_id: number; uid: number; flags: string }>(
      "SELECT message_id, uid, flags FROM message_locations WHERE account_id = ? AND mailbox = ? AND uidvalidity = ?",
      this.accountId,
      mailbox,
      uidvalidity,
    );
  }

  /**
   * UIDVALIDITY changed (or the folder is gone): forgets every location in the mailbox, a slice at a time with a
   * yield between (Codex R2: a big folder in one transaction held the backend for tens of milliseconds). Membership
   * in an IMAP folder is its locations there, so its rows go as they are, with no thread refolded; re-identified
   * mail comes back location by location.
   */
  async resetMailbox(mailbox: string) {
    // the ids as each slice deletes them (Codex R41: never the whole mailbox read first)
    const ids: number[] = [];
    for (;;) {
      const removed = this.db.tx(
        () =>
          this.db
            .all<{ message_id: number }>(
              "DELETE FROM message_locations WHERE mailbox = ? AND message_id IN (SELECT message_id FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? LIMIT ?) RETURNING message_id",
              mailbox,
              this.accountId,
              mailbox,
              RESET_SLICE,
            )
            .map((r) => ids.push(r.message_id)).length +
          this.db.run(
            "DELETE FROM thread_folders WHERE folder = ? AND thread_id IN (SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT ?)",
            mailbox,
            this.accountId,
            mailbox,
            RESET_SLICE,
          ).changes,
      );
      if (removed === 0) return ids;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async twins(e: { subject: string; fromEmail: string; date: number; size: number; rfcMessageId?: string | null }, afterId: number, limit: number) {
    if (e.rfcMessageId)
      return this.db
        .all<{ id: number }>(
          "SELECT id FROM messages INDEXED BY messages_rfc WHERE account_id = ? AND rfc_message_id = ? AND from_email = ? AND date = ? AND size = ? AND subject = ? AND id > ? ORDER BY id LIMIT ?",
          this.accountId,
          e.rfcMessageId,
          e.fromEmail,
          e.date,
          e.size,
          e.subject,
          afterId,
          limit,
        )
        .map((r) => r.id);
    return this.db
      .all<{ id: number }>(
        "SELECT id FROM messages INDEXED BY messages_twins WHERE account_id = ? AND from_email = ? AND date = ? AND size = ? AND subject = ? AND rfc_message_id IS NULL AND id > ? ORDER BY id LIMIT ?",
        this.accountId,
        e.fromEmail,
        e.date,
        e.size,
        e.subject,
        afterId,
        limit,
      )
      .map((r) => r.id);
  }

  async unlocated(afterId: number, span: number) {
    const ids = this.db
      .all<{ id: number }>("SELECT id FROM messages m WHERE id > ? AND id <= ? AND account_id = ? AND NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id) ORDER BY id", afterId, afterId + span, this.accountId)
      .map((r) => r.id);
    return { ids, more: (this.db.get<{ top: number | null }>("SELECT max(id) AS top FROM messages")!.top ?? 0) > afterId + span };
  }

  async envelopes(messageIds: readonly number[]) {
    const out: { id: number; subject: string; fromEmail: string; date: number; size: number; rfcMessageId: string | null }[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      out.push(...this.db.all<{ id: number; subject: string; fromEmail: string; date: number; size: number; rfcMessageId: string | null }>(
        `SELECT id, subject, from_email AS fromEmail, date, size, rfc_message_id AS rfcMessageId FROM messages WHERE account_id = ? AND id IN (${placeholders(chunk.length)})`,
        this.accountId,
        ...chunk,
      ));
    }
    return out;
  }

  async resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string; rfcMessageId?: string | null }) {
    return (
      this.db.get<{ id: number }>(
        `SELECT id FROM messages WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))
           AND rfc_message_id IS ? AND subject = ? AND from_email = ? AND date = ? AND size = ?
           AND NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = messages.id AND l.mailbox = ?)
         ORDER BY id LIMIT 1`,
        this.accountId,
        JSON.stringify(c.candidates),
        c.rfcMessageId ?? null,
        c.subject,
        c.fromEmail,
        c.date,
        c.size,
        c.mailbox,
      ) ?? null
    );
  }
}
