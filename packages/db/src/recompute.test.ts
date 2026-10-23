import type { ThreadAction } from "@unica/core";
import { baseSubject } from "@unica/core";
import { expect, it } from "vitest";
import { applyThreadAction } from "./actions";
import { deleteMessages, ingestMessages } from "./ingest";
import type { Db } from "./sqlite";
import { msg, testDb, withAccounts } from "./test/helpers";

/** The definition of a thread's derived columns, in SQL, as recomputeThreads has always computed them. */
function expected(db: Db, threadId: number) {
  const agg = db.get<Record<string, number>>(
    `SELECT count(*) AS c, coalesce(sum(is_read = 0 AND is_trash = 0), 0) AS unread, coalesce(max(has_attachments), 0) AS att,
            coalesce(max(is_starred AND is_trash = 0), 0) AS starred, coalesce(max(in_inbox AND is_trash = 0 AND is_spam = 0), 0) AS inbox,
            coalesce(max(is_sent AND is_trash = 0 AND is_spam = 0), 0) AS sent, coalesce(min(is_trash), 0) AS trash_all,
            coalesce(sum(is_trash = 0), 0) AS visible, coalesce(sum(is_trash = 0 AND is_spam = 0), 0) AS visible_nonspam
     FROM messages WHERE thread_id = ?`,
    threadId,
  )!;
  const latest = db.get<{ date: number; from_name: string; from_email: string; snippet: string }>(
    "SELECT date, from_name, from_email, snippet FROM messages WHERE thread_id = ? ORDER BY (is_trash OR is_spam) ASC, date DESC, id DESC LIMIT 1",
    threadId,
  )!;
  const counterpart = db.get<{ from_name: string; from_email: string }>(
    "SELECT from_name, from_email FROM messages WHERE thread_id = ? AND is_sent = 0 ORDER BY (is_trash OR is_spam) ASC, date DESC, id DESC LIMIT 1",
    threadId,
  );
  const first = db.get<{ subject: string }>("SELECT subject FROM messages WHERE thread_id = ? ORDER BY date ASC, id ASC LIMIT 1", threadId)!;
  return {
    subject: baseSubject(first.subject) || first.subject,
    snippet: latest.snippet,
    last_date: latest.date,
    last_from_name: counterpart?.from_name ?? latest.from_name,
    last_from_email: counterpart?.from_email ?? latest.from_email,
    message_count: agg.c,
    unread_count: agg.unread,
    has_attachments: agg.att,
    is_starred: agg.starred,
    in_inbox: agg.inbox,
    has_sent: agg.sent,
    in_trash: agg.trash_all,
    in_spam: agg.visible! > 0 && agg.visible_nonspam === 0 ? 1 : 0,
  };
}

it("recomputed threads equal the SQL definition after random ingests, actions and deletes (ties, sent-only, trash, spam)", () => {
  const db = testDb();
  const accounts = withAccounts(db, 2);
  let seed = 13;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const actions: ThreadAction[] = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"];
  const rfc: string[] = [];
  for (let step = 0; step < 600; step++) {
    const r = rand();
    if (r < 0.55 || rfc.length === 0) {
      const id = `rc${step}@x`;
      ingestMessages(db, [
        msg({
          accountId: pick(accounts),
          rfcMessageId: id,
          inReplyTo: rfc.length && rand() < 0.7 ? pick(rfc) : null,
          // few distinct dates: ties are broken by id
          date: 1_700_000_000_000 + Math.floor(rand() * 5) * 1000,
          subject: pick(["Factura", "Re: Factura", "RE: Fwd: Hola", "", "Reunión"]),
          snippet: `s${step}`,
          from: pick([{ name: "Ana", email: "ana@x.mx" }, { name: "", email: "me0@example.com" }, { name: "Beto", email: "beto@y.io" }]),
          isRead: rand() < 0.5,
          isSent: rand() < 0.3,
          inInbox: rand() < 0.6,
          isSpam: rand() < 0.15,
          isTrash: rand() < 0.15,
          isStarred: rand() < 0.2,
          hasAttachments: rand() < 0.2,
        }),
      ]);
      rfc.push(id);
    } else if (r < 0.9) {
      const threads = db.all<{ id: number }>("SELECT id FROM threads").map((t) => t.id);
      if (threads.length) applyThreadAction(db, [pick(threads)], pick(actions));
    } else {
      const ids = db.all<{ id: number }>("SELECT id FROM messages").map((m) => m.id);
      if (ids.length) deleteMessages(db, [pick(ids)]);
    }
  }
  const threads = db.all<Record<string, unknown> & { id: number }>("SELECT * FROM threads ORDER BY id");
  expect(threads.length).toBeGreaterThan(50);
  for (const t of threads) expect(t, String(t.id)).toMatchObject(expected(db, t.id));
  expect(db.get("SELECT count(*) AS c FROM threads WHERE id NOT IN (SELECT thread_id FROM messages)")).toEqual({ c: 0 });
});
