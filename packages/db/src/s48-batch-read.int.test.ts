import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

for (const reader of ["thread", "snapshot", "sentTexts", "sentAfter"] as const) for (const captured of [true, false]) it(`retains the selected ${captured ? "captured" : "inline"} batch through ${reader} replacement`, async () => {
  const db = openDatabase(":memory:");
  let hold = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  const store = new SqlMailStore(db, { platform, instantSearch: false });
  let reading: Promise<unknown> | undefined;
  const first = "First exact body\r\n😀 ".repeat(2200), old = captured ? "Second old body\r\n🧡 ".repeat(2300) : "old inline body", fresh = "Replacement complete body\r\n🦉 ".repeat(2400);
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "first", providerThreadId: "shared", bodyText: first, bodyHtml: "<p>first</p>", bodyState: "full", isSent: true, size: 100 }), msg({ accountId: accountId!, providerMsgId: "second", providerThreadId: "shared", bodyText: old, bodyHtml: "<p>old exact HTML</p>", bodyState: "full", isSent: true, size: 100 })], { now: 1, classifier: null, applyFilters: false });
    const thread = (await store.threads.get(result.touched[0]!))!, ids = thread.messages.map((m) => m.id);
    const second = thread.messages[1]!;
    const read = async () => {
      if (reader === "thread") return (await store.threads.get(result.touched[0]!))!.messages.map((m) => ({ id: m.id, text: m.bodyText }));
      if (reader === "snapshot") return (await store.debug.snapshot()).messages.map((m) => ({ id: m.id, text: m.bodyText }));
      const rows = reader === "sentTexts" ? await store.autocomplete.sentTexts(ids) : (await store.autocomplete.sentAfter(0, 10)).texts;
      return rows.map((m) => ({ id: m.id, text: m.text }));
    };
    hold = true; reading = read(); await started; console.info("reader held");
    await store.sync.setBody(second.id, fresh, "<p>fresh HTML</p>", { now: 2, classifier: null });
    release();
    const rows = await reading as { id: number; text: string }[];
    expect(rows.find((m) => m.id === second.id)?.text === (reader.startsWith("sent") ? [...old].slice(0, 65536).join("") : old)).toBe(true);
    expect((await store.threads.get(result.touched[0]!))!.messages.find((m) => m.id === second.id)!.bodyText === fresh).toBe(true);
  } finally { release(); await reading?.catch(() => {}); await store.close(); }
});

for (const failure of ["acquisition", "read"] as const) it(`releases the whole selected batch after ${failure} failure`, async () => {
  const { vi } = await import("vitest");
  const { sqlBodyProtocol } = await import("./body-parts");
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform: nodePlatform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    const r = await store.sync.ingest([msg({ accountId: accountId!, providerThreadId: "batch", bodyText: "first complete body ".repeat(3000) }), msg({ accountId: accountId!, providerThreadId: "batch", bodyText: "second complete body ".repeat(3000) })], { now: 1, classifier: null, applyFilters: false });
    const rows = db.all<{ message_id: number; capture_id: string }>("SELECT message_id,capture_id FROM body_heads ORDER BY message_id");
    const fault = new Error("Synthetic selected source failure"), get = db.get.bind(db);
    let armed = true;
    const spy = vi.spyOn(db, "get").mockImplementation((sql, ...args) => {
      if (armed && (failure === "acquisition" ? sql.includes("WHERE b.message_id=? AND c.ready=1") && args[0] === rows[1]!.message_id : sql === "SELECT ordinal,value FROM body_parts WHERE capture_id=? AND field=? AND ordinal=?")) { armed = false; throw fault; }
      return get(sql, ...args);
    });
    try { await expect(store.threads.get(r.touched[0]!)).rejects.toBe(fault); }
    finally { spy.mockRestore(); }
    for (const row of rows) expect(sqlBodyProtocol(db).held(row.capture_id)).toBe(false);
    for (const row of rows) await store.sync.setBody(row.message_id, "replacement", null, { now: 2, classifier: null });
    expect((await store.threads.get(r.touched[0]!))!.messages.map((m) => m.bodyText)).toEqual(["replacement", "replacement"]);
  } finally { await store.close(); }
});
