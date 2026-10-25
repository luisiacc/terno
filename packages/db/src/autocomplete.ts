import { addressesOf, RevisionError, SENT_TEXT_MAX, type AutocompleteSource, type ContactBatch, type ContactBuild, type ContactMessage, type SentText } from "@terno/store";
import { searchChangeIds, searchHead } from "./outbox";
import type { Db } from "./sqlite";

/**
 * Autocomplete's reads (plan 18) over the shared SQL layer: message headers
 * by id or in id order, the senders of conversations now in spam, and the
 * user's sent text (at most SENT_TEXT_MAX characters, cut in SQL so a huge
 * body is never read whole). The change log is search's (v7): no schema of
 * its own.
 */
const CONTACT = `SELECT m.id, m.account_id, m.date, m.is_sent, m.is_spam, m.is_draft, m.from_name, m.from_email, m.to_json, m.cc_json, m.bcc_json, m.body_state FROM messages m`;
const SENT = `SELECT m.id, m.account_id, m.date, m.from_name, m.to_json, substr(b.body_text, 1, ${SENT_TEXT_MAX}) AS text
  FROM messages m JOIN message_bodies b ON b.message_id = m.id
  WHERE m.is_sent = 1 AND m.is_spam = 0 AND m.is_draft = 0 AND b.body_text IS NOT NULL`;

interface ContactRow {
  id: number;
  account_id: number;
  date: number;
  is_sent: number;
  is_spam: number;
  is_draft: number;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  body_state: string;
}

interface SentRow {
  id: number;
  account_id: number;
  date: number;
  from_name: string;
  to_json: string;
  text: string;
}

const toContact = (r: ContactRow): ContactMessage => ({
  id: r.id,
  accountId: r.account_id,
  date: r.date,
  sent: r.is_sent === 1,
  spam: r.is_spam === 1,
  draft: r.is_draft === 1,
  from: { name: r.from_name, email: r.from_email },
  to: addressesOf(r.to_json),
  cc: addressesOf(r.cc_json),
  bcc: addressesOf(r.bcc_json),
  hasBody: r.body_state !== "none",
});

const toSent = (r: SentRow): SentText => ({ id: r.id, accountId: r.account_id, date: r.date, fromName: r.from_name, to: addressesOf(r.to_json), text: r.text });

export function contactMessages(db: Db, ids: readonly number[]): ContactMessage[] {
  return db.all<ContactRow>(`${CONTACT} WHERE m.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map(toContact);
}

export function contactMessagesAfter(db: Db, afterId: number, limit: number): ContactMessage[] {
  return db.all<ContactRow>(`${CONTACT} WHERE m.id > ? ORDER BY m.id LIMIT ?`, afterId, limit).map(toContact);
}

/** Senders of received mail in these conversations, where the conversation is now in spam. */
export function spamSenders(db: Db, threadIds: readonly number[]): string[] {
  if (!threadIds.length) return [];
  return db
    .all<{ e: string }>(
      `SELECT DISTINCT m.from_email AS e FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE t.id IN (SELECT value FROM json_each(?)) AND t.in_spam = 1 AND m.is_sent = 0`,
      JSON.stringify(threadIds),
    )
    .map((r) => r.e);
}

export function sentTexts(db: Db, ids: readonly number[]): SentText[] {
  if (!ids.length) return [];
  return db.all<SentRow>(`${SENT} AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id`, JSON.stringify(ids)).map(toSent);
}

export function sentAfter(db: Db, afterId: number, limit: number): SentText[] {
  return db.all<SentRow>(`${SENT} AND m.id > ? ORDER BY m.id LIMIT ?`, afterId, limit).map(toSent);
}

/** Ids per read when serving a large commit (500 headers read in ~1 ms). */
const SLICE = 500;

export function sqlAutocompleteSource(db: Db, yieldTo: () => Promise<void>, identity: string): AutocompleteSource {
  return {
    snapshotBase: db.path === ":memory:" ? null : db.path,
    identity,
    head: async () => searchHead(db),
    changes: async (after, through, maxCommits) => {
      const out: ContactBatch[] = [];
      for (const c of searchChangeIds(db, after, through, maxCommits)) {
        const messages: ContactMessage[] = [];
        const present = new Set<number>();
        for (let i = 0; i < c.messageIds.length; i += SLICE) {
          if (i) await yieldTo();
          if (!db.isOpen) throw new RevisionError("epoch", "the store closed");
          for (const m of contactMessages(db, c.messageIds.slice(i, i + SLICE))) {
            messages.push(m);
            present.add(m.id);
          }
        }
        const spam: string[] = [];
        for (let i = 0; i < c.threadIds.length; i += SLICE) {
          if (i || c.messageIds.length > SLICE) await yieldTo();
          spam.push(...spamSenders(db, c.threadIds.slice(i, i + SLICE)));
        }
        out.push({ from: c.from, to: c.to, messages, removed: c.messageIds.filter((id) => !present.has(id)), spamSenders: spam });
      }
      return out;
    },
    beginBuild: async (): Promise<ContactBuild> => {
      const { from, lease } = db.tx(() => {
        const from = searchHead(db);
        return { from, lease: db.run("INSERT INTO search_leases (from_seq, created_at) VALUES (?, ?)", from.seq, Date.now()).lastInsertRowid };
      });
      return {
        from,
        async *messages() {
          for (let after = 0; ; ) {
            if (!db.isOpen) return;
            const page = contactMessagesAfter(db, after, SLICE);
            if (page.length === 0) return;
            yield page;
            after = page[page.length - 1]!.id;
          }
        },
        release: async () => {
          if (db.isOpen) db.run("DELETE FROM search_leases WHERE id = ?", lease);
        },
      };
    },
    sentAfter: async (afterId, limit) => sentAfter(db, afterId, limit),
    sentTexts: async (ids) => sentTexts(db, ids),
  };
}
