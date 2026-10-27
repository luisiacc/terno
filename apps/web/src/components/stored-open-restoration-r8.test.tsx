// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { setup, gate, deferred } from "./draft-presentation-r1-harness";

it.each(["restored account", "publication restored", "direct departure", "unrelated", "ordinary"] as const)("stored-open retains pre-lease account history: %s", async (scenario) => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { openDatabase, SqlMailStore, nodePlatform } = await import("@terno/db"), { BackendCore, plaintextCipher } = await import("../../../../packages/backend/src/core"), { RpcClient, createMemoryTransportPair } = await import("@terno/core/rpc"), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
  const dir = mkdtempSync(join(tmpdir(), "terno-r8-stored-open-")), store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const providers: import("@terno/mail").ProviderRegistry = { create: () => { throw new Error("Unexpected provider"); }, connectGmail: async () => { throw new Error("Unexpected provider"); }, verifyImap: async () => { throw new Error("Unexpected provider"); } };
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "r8-stored", origin: "renderer" }); const client = new RpcClient(c);
  const h = await setup("split"), entered = deferred<void>(), release = deferred<void>();
  const { getSelectionWriteRevision } = await import("~/state/app");
  let restored = false, armed = false, off = () => {}, offPublication = () => {};
  try {
    const [account, other] = await withAccounts(store);
    await ingest(store, [msg({ accountId: account!, providerMsgId: "source", attachments: [] })]);
    const threadId = await threadOf(store, "source"), detail = (await store.threads.get(threadId))!, source = detail.messages[0]!;
    const saved = (await client.call("drafts.save", { accountId: account!, threadId: null, mode: "reply", showSourceContext: true, inReplyToMessageId: source.id, bodyText: "exact authored body", bodyHtml: "<p>exact authored body</p>" }))!;
    await act(async () => { h.drafts.useDrafts.setState({ drafts: { [h.key]: { ...h.drafts.fromServer(saved), key: h.key } } }); h.app.setApp({ accounts: await store.accounts.list(), accountId: account!, selectedId: null, readerOpen: false, draftShown: null, draftFocus: null }); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    gate.call.mockImplementation(async (method, params) => { if (method !== "drafts.sourceContext") return {}; const result = await client.call("drafts.sourceContext", params); if (!armed) { armed = true; entered.resolve(); await release.promise; } return result; });
    gate.load.mockImplementation(async (id) => { const value = await store.threads.get(id); if (value) h.useThreads.setState((state) => ({ details: new Map(state.details).set(id, value) })); return value; });
    off = h.app.useApp.subscribe((state, previous) => { if ((scenario === "restored account" || scenario === "publication restored") && !restored && previous.accountId === account && state.accountId === other) { restored = true; h.app.setApp({ accountId: account! }); } });
    offPublication = h.app.useApp.subscribe((state, previous) => { if (scenario === "publication restored" && !restored && previous.selectedId === null && state.selectedId === threadId) h.app.setApp({ accountId: other! }); });
    const button = h.host.querySelector<HTMLButtonElement>(`[data-testid="strip-item"][data-key="${h.key}"]`)!;
    expect(button).not.toBeNull();
    await act(async () => { button.focus(); button.click(); });
    await entered.promise;
    const revision = getSelectionWriteRevision();
    expect(h.app.getApp().draftShown).toBeNull(); expect(h.app.getApp().draftFocus).toBeNull();
    if (scenario === "restored account") await act(async () => { h.app.setApp({ accountId: other! }); });
    if (scenario === "direct departure") await act(async () => { h.app.setApp({ accountId: other! }); });
    if (scenario === "unrelated") await act(async () => { h.app.setApp({ snackbar: true }); h.app.setApp({ snackbar: false }); });
    expect(restored).toBe(scenario === "restored account"); expect(getSelectionWriteRevision()).toBe(revision);
    await act(async () => { release.resolve(); }); for (let i = 0; i < 4; i++) await h.flush();
    if (scenario === "publication restored") expect(restored).toBe(true);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    if (scenario === "restored account" || scenario === "direct departure" || scenario === "publication restored") { if (scenario !== "publication restored") expect(h.app.getApp().selectedId).toBeNull(); expect(h.app.getApp().draftShown).toBeNull(); expect(h.app.getApp().draftFocus).toBeNull(); }
    else expect(h.app.getApp().draftShown?.key).toBe(h.key);
  } finally { release.resolve(); offPublication(); off(); await h.cleanup(); c.close(); try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
});
