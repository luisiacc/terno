import { describe, expect, it } from "vitest";
import { SqlMailStore } from "./sql-store";
import { msg, testDb, withAccounts } from "./test/helpers";
import type { IncomingMessage } from "./ingest";

describe("portable ingestion identity lookup", () => {
  function fixture() {
    const db = testDb();
    const [gmail, imap, other] = withAccounts(db, 3);
    const store = new SqlMailStore(db, { instantSearch: false });
    const ingest = (messages: IncomingMessage[]) => store.sync.ingest(messages, { applyFilters: false, now: 0, classifier: null });
    const rows = () => db.all<{ id: number; account_id: number; provider_msg_id: string | null; rfc_message_id: string | null }>("SELECT id, account_id, provider_msg_id, rfc_message_id FROM messages ORDER BY id");
    return { db, store, gmail: gmail!, imap: imap!, other: other!, ingest, rows };
  }

  it("inserts a fresh remote row through the public store", async () => {
    const { gmail, ingest, rows } = fixture();
    const result = await ingest([msg({ accountId: gmail, providerMsgId: "fresh", rfcMessageId: "<FRESH@test>" })]);
    expect(rows()).toEqual([{ id: result.inserted[0], account_id: gmail, provider_msg_id: "fresh", rfc_message_id: "fresh@test" }]);
  });

  it.each(["gmail", "imap"] as const)("updates the exact provider row in its own %s account", async (kind) => {
    const { db, gmail, imap, ingest, rows } = fixture();
    const input = msg({ accountId: kind === "gmail" ? gmail : imap, providerMsgId: "remote" });
    const first = await ingest([input]);
    expect((await ingest([{ ...input, bodyText: "replacement" }])).inserted).toEqual([]);
    expect(rows().map((row) => row.id)).toEqual(first.inserted);
    expect(db.get("SELECT body_text FROM message_bodies WHERE message_id=?", first.inserted[0]!)).toEqual({ body_text: "replacement" });
  });

  it.each(["gmail", "imap"] as const)("limits normalized local RFC adoption for %s", async (kind) => {
    const { gmail, imap, ingest, rows } = fixture();
    const accountId = kind === "gmail" ? gmail : imap;
    const local = msg({ accountId, providerMsgId: "local:sent", rfcMessageId: "<SENT@test>" });
    const first = await ingest([local]);
    const next = await ingest([{ ...local, providerMsgId: "remote-sent", rfcMessageId: "sent@test" }]);
    expect(next.inserted).toHaveLength(kind === "gmail" ? 0 : 1);
    expect(rows().map((row) => [row.id, row.provider_msg_id])).toEqual(kind === "gmail"
      ? [[first.inserted[0], "remote-sent"]]
      : [[first.inserted[0], "local:sent"], [next.inserted[0], "remote-sent"]]);
  });

  it("prefers the provider match over an older local RFC match during staging and ingestion", async () => {
    const { db, store, gmail, ingest, rows } = fixture();
    const saved = await store.attachments.create({ accountId: gmail, filename: "saved.txt", mime: "text/plain", size: 0, now: 0 });
    await store.attachments.seal(gmail, saved.assetId);
    const local = msg({ accountId: gmail, providerMsgId: "local:older", rfcMessageId: "shared@test", attachments: [{ filename: "local.txt", mime: "text/plain", size: 1 }] });
    const remote = msg({ accountId: gmail, providerMsgId: "remote", rfcMessageId: "different@test", attachments: [saved] });
    const first = await ingest([local, remote]);
    const attachment = { filename: "saved.txt", mime: "text/plain", size: 0, bytes: new Uint8Array(0) };
    expect((await ingest([{ ...remote, rfcMessageId: "<SHARED@test>", bodyText: "selected", attachments: [attachment] }])).inserted).toEqual([]);
    expect(rows().map((row) => row.provider_msg_id)).toEqual(["local:older", "remote"]);
    expect(db.all("SELECT message_id, filename FROM attachments ORDER BY message_id")).toEqual([{ message_id: first.inserted[0], filename: "local.txt" }, { message_id: first.inserted[1], filename: "saved.txt" }]);
    expect(db.all("SELECT message_id, asset_id FROM attachment_links")).toEqual([{ message_id: first.inserted[1], asset_id: saved.assetId }]);
    expect(db.get("SELECT body_text FROM message_bodies WHERE message_id=?", first.inserted[0]!)).toEqual({ body_text: local.bodyText });
    expect(db.get("SELECT body_text FROM message_bodies WHERE message_id=?", first.inserted[1]!)).toEqual({ body_text: "selected" });
  });

  it("isolates duplicate provider and local RFC identities in another account", async () => {
    const { gmail, other, ingest, rows } = fixture();
    await ingest([msg({ accountId: other, providerMsgId: "duplicate", rfcMessageId: "shared@test" }), msg({ accountId: other, providerMsgId: "local:foreign", rfcMessageId: "local@test" })]);
    const result = await ingest([msg({ accountId: gmail, providerMsgId: "duplicate", rfcMessageId: "shared@test" }), msg({ accountId: gmail, providerMsgId: "new", rfcMessageId: "<LOCAL@test>" })]);
    expect(result.inserted).toHaveLength(2);
    expect(rows().map((row) => row.account_id)).toEqual([other, other, gmail, gmail]);
  });

  it("chooses the lowest local id and does not adopt a non-local RFC twin", async () => {
    const { db, gmail, ingest, rows } = fixture();
    const older = msg({ accountId: gmail, providerMsgId: "LOCAL:first", rfcMessageId: "first@test" });
    const newer = msg({ accountId: gmail, providerMsgId: "local:second", rfcMessageId: "second@test" });
    const first = await ingest([older, newer]);
    // Ingestion preserves an existing row's RFC identity; seed the competing legacy row explicitly.
    db.run("UPDATE messages SET rfc_message_id=? WHERE id=?", "first@test", first.inserted[1]!);
    expect((await ingest([{ ...older, providerMsgId: "adopted" }])).inserted).toEqual([]);
    expect(rows().map((row) => [row.id, row.provider_msg_id])).toEqual([[first.inserted[0], "adopted"], [first.inserted[1], "local:second"]]);
    expect((await ingest([msg({ accountId: gmail, providerMsgId: "unrelated", rfcMessageId: "second@test" })])).inserted).toHaveLength(1);
    expect((await ingest([msg({ accountId: gmail, providerMsgId: "remote-twin", rfcMessageId: "second@test" })])).inserted).toHaveLength(1);
  });

  it("does not equate null provider or absent RFC identities", async () => {
    const { gmail, ingest, rows } = fixture();
    const input = msg({ accountId: gmail, providerMsgId: null, rfcMessageId: null });
    expect((await ingest([input, input])).inserted).toHaveLength(2);
    await ingest([msg({ accountId: gmail, providerMsgId: "local:null", rfcMessageId: null })]);
    expect((await ingest([msg({ accountId: gmail, providerMsgId: "remote-null", rfcMessageId: null })])).inserted).toHaveLength(1);
    expect(rows()).toHaveLength(4);
  });
});
