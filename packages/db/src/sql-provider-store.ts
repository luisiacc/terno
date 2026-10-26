import type { ImapLocation, ImapLocationStore, ProviderStore } from "@terno/store";
import { getSetting } from "./repos";
import { placeholders, type Db } from "./sqlite";

/** One account's provider-side reads and IMAP identity, as the providers used to run them on the database. */
export class SqlProviderStore implements ProviderStore {
  readonly locations: ImapLocationStore;

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

class SqlImapLocations implements ImapLocationStore {
  constructor(
    private readonly db: Db,
    private readonly accountId: number,
  ) {}

  async upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) {
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
    this.db.run("DELETE FROM message_locations WHERE message_id = ? AND mailbox = ?", messageId, mailbox);
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

  async inMailbox(mailbox: string, uidvalidity: number) {
    return this.db.all<{ message_id: number; uid: number; flags: string }>(
      "SELECT message_id, uid, flags FROM message_locations WHERE account_id = ? AND mailbox = ? AND uidvalidity = ?",
      this.accountId,
      mailbox,
      uidvalidity,
    );
  }

  async resetMailbox(mailbox: string) {
    return this.db.tx(() => {
      const ids = this.db
        .all<{ message_id: number }>("SELECT message_id FROM message_locations WHERE account_id = ? AND mailbox = ?", this.accountId, mailbox)
        .map((r) => r.message_id);
      this.db.run("DELETE FROM message_locations WHERE account_id = ? AND mailbox = ?", this.accountId, mailbox);
      return ids;
    });
  }

  async resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string }) {
    return (
      this.db.get<{ id: number }>(
        `SELECT id FROM messages WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))
           AND rfc_message_id IS NULL AND subject = ? AND from_email = ? AND date = ? AND size = ?
           AND NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = messages.id AND l.mailbox = ?)
         ORDER BY id LIMIT 1`,
        this.accountId,
        JSON.stringify(c.candidates),
        c.subject,
        c.fromEmail,
        c.date,
        c.size,
        c.mailbox,
      ) ?? null
    );
  }
}
