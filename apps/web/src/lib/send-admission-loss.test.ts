import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError, type MethodName, type ParamsOf } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";

const rpc = vi.hoisted(() => ({ call: undefined as undefined | ((method: MethodName, params: unknown) => Promise<unknown>) }));
vi.mock("~/rpc/connection", () => ({ client: { call: (method: MethodName, params: unknown) => rpc.call!(method, params) } }));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));
const { sendDraft } = await import("./compose");
const { createDraft, editDraft, discardDraft, flushDraft, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");

for (const adapter of ["SQL", "IDB"] as const) it.each([false, true])(`${adapter}: unsaved ordinary Send has no durable duplicate key after lost ACK (autosave=%s)`, async (autosave) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-unsaved-admission-"));
  const store = adapter === "SQL" ? new SqlMailStore(openDatabase(join(dir, "mail.db"))) : await IdbMailStore.open({ name: crypto.randomUUID(), factory: new IDBFactory(), platform: nodePlatform, instantSearch: false });
  const backend = new BackendCore({ store, platform: nodePlatform, cipher: plaintextCipher, version: "test", autoSync: false, providers: {
    create() { throw new Error("No dispatch authorized in admission characterization"); }, async verifyImap() {}, async connectGmail() { throw new Error("No Google authorized"); },
  } });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "renderer-loss", origin: "renderer" }); const client = new RpcClient(c);
  let lose = true;
  const submissions: ParamsOf<"compose.send">[] = [];
  rpc.call = async (method, params) => {
    if (method === "compose.send") submissions.push(params as ParamsOf<"compose.send">);
    const result = await client.call(method, params as never);
    if (method === "compose.send" && lose) { lose = false; throw new RpcError("TIMEOUT", "Synthetic response lost after admission"); }
    return result;
  };
  try {
    await backend.ready;
    const { account } = await store.accounts.create({ kind: "gmail", email: "author@example.test", displayName: "Original", color: "indigo", now: 1 });
    setApp({ accounts: [account] }); useDrafts.setState({ drafts: {} });
    const key = createDraft({ ...newFields(account.id), toText: "recipient@example.test", subject: "Original", bodyText: "Preserved authored body" });
    editDraft(key, {});
    expect(await sendDraft(key)).toBe(false);
    expect(submissions[0]?.draftId).toBeUndefined();
    expect(await client.call("ops.list", {})).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "Preserved authored body", sending: false });
    if (autosave) { await flushDraft(key); expect(useDrafts.getState().drafts[key]?.id).not.toBeNull(); }
    expect(await sendDraft(key)).toBe(true);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.draftId !== undefined).toBe(autosave);
    const operations = await client.call("ops.list", {});
    expect(operations).toHaveLength(2); expect(new Set(operations.map((op) => op.id)).size).toBe(2);
    const payloads = await Promise.all(operations.map(async (op) => JSON.parse((await store.ops.get(op.id))!.payload_json)));
    for (const payload of payloads) expect(payload).toMatchObject({ text: "Preserved authored body", subject: "Original", from: { email: "author@example.test" }, to: [{ email: "recipient@example.test", name: "" }] });
  } finally {
    for (const key of Object.keys(useDrafts.getState().drafts)) await discardDraft(key); client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); rpc.call = undefined;
  }
});
