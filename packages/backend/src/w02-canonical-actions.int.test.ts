import { afterEach, describe, expect, it, vi } from "vitest";
import { actionFixture } from "./w02-action-fixture";
import { msg } from "../../store/src/conformance/fixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); } });
async function setup(kind: "SQL" | "IDB", count = 1, shared = true) {
  return actionFixture(kind, count, shared, (close) => { cleanups.push(close); });
}

describe.each(["SQL", "IDB"] as const)("W02 independent canonical actions: %s", (kind) => {
  it.each(["Restore", "Undo"] as const)("preserves newer %s through actual 1000+1 chunk refusal and queued reopen", async (newer) => {
    const t = await setup(kind, 1001);
    const threadId = t.selected[0]!.threadId, ids = t.selected.map((m) => m.id);
    expect(new Set(t.selected.map((m) => m.threadId)).size).toBe(1);
    const action = await t.client.call("threads.act", { threadIds: [threadId], action: "archive" });
    expect(action.affected).toBe(1);
    const admitted = (await t.backend.store.debug.snapshot()).ops;
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ kind: "archive", state: "queued", attempts: 0, messageIds: ids });
    const held = t.holdMutation(2, 400), worker = t.backend.runWorker();
    let claims: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await held.entered.promise;
      expect(t.mutations.map((m) => [m.ids.length, m.applied])).toEqual([[1000, true], [1, false]]);
      expect(t.mutations.flatMap((m) => m.ids)).toEqual(t.selected.map((m) => m.providerMsgId));
      expect([...t.remote.get(t.accounts[0]!)!.values()].filter((labels) => labels.has("INBOX"))).toHaveLength(2);
      const running = await t.backend.store.ops.get(admitted[0]!.id);
      expect(running).toMatchObject({ state: "running", attempts: 1 });
      expect(JSON.parse(running!.target_json).messageIds).toEqual(ids);
      // Withhold later queue admission, so persisted correction is reopened before dispatch.
      claims = vi.spyOn(t.backend.store.ops, "claimReady").mockResolvedValue([]);
      if (newer === "Undo") expect(await t.client.call("threads.undo", { undoId: action.undoId! })).toEqual({ restored: 1 });
      else expect((await t.client.call("threads.act", { threadIds: [threadId], action: "moveToInbox" })).affected).toBe(1);
    } finally { held.response.release(); await worker; claims?.mockRestore(); }
    const partial = await t.backend.store.debug.snapshot();
    expect(partial.ops.find((op) => op.id === admitted[0]!.id)).toMatchObject({ state: "failed", attempts: 1, messageIds: ids });
    const correction = partial.ops.filter((op) => op.state === "queued");
    expect(correction.length).toBeGreaterThan(0);
    expect(correction.every((op) => op.kind === "moveToInbox" && op.attempts === 0)).toBe(true);
    expect(correction.flatMap((op) => op.messageIds).sort((a, b) => a - b)).toEqual(ids);
    expect(partial.messages.filter((m) => ids.includes(m.id)).every((m) => m.inInbox && !m.isRead && !m.isStarred && !m.isTrash && !m.isSpam)).toBe(true);
    await t.reopen();
    expect((await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued")).toEqual(correction);
    expect(await t.drain()).toBe(correction.length);
    await t.backend.syncAccount(t.accounts[0]!);
    const settled = await t.backend.store.debug.snapshot();
    expect(settled.ops.find((op) => op.id === admitted[0]!.id)).toMatchObject({ state: "failed", attempts: 1, messageIds: ids });
    expect(settled.ops.filter((op) => op.id !== admitted[0]!.id)).toEqual(correction.map((op) => ({ ...op, state: "succeeded", attempts: 1 })));
    expect(await t.backend.store.sync.pendingMessageIds(t.accounts[0]!)).toEqual(new Set());
    expect(settled.messages.filter((m) => ids.includes(m.id)).every((m) => m.inInbox && !m.isTrash && !m.isSpam && !m.isRead && !m.isStarred)).toBe(true);
    expect(settled.messages.filter((m) => !ids.includes(m.id))).toEqual(t.siblings);
    for (const account of t.remote.values()) for (const labels of account.values()) expect([...labels].sort()).toEqual(["INBOX", "UNREAD"]);
    expect(t.mutations.every((m) => m.accountId === t.accounts[0] && m.ids.every((id) => id !== "sibling"))).toBe(true);
    expect(t.mutations.slice(2).flatMap((m) => m.ids).sort()).toEqual(t.selected.map((m) => m.providerMsgId).sort());
    expect((await t.backend.store.providerStore(t.accounts[0]!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect(await t.backend.store.ops.nextAttemptAt()).toBeNull();
    expect(await t.backend.runWorker()).toBe(0);
    await t.backend.store.debug.verify();
  });

  it("without newer Restore, a terminal second chunk exposes actual partial state without replay", async () => {
    const t = await setup(kind, 1001), ids = t.selected.map((m) => m.id);
    await t.client.call("threads.act", { threadIds: [t.selected[0]!.threadId], action: "archive" });
    const [op] = (await t.backend.store.debug.snapshot()).ops;
    const held = t.holdMutation(2, 400), worker = t.backend.runWorker();
    try {
      await held.entered.promise;
      expect(t.mutations.map((m) => [m.ids.length, m.applied])).toEqual([[1000, true], [1, false]]);
    } finally { held.response.release(); expect(await worker).toBe(1); }
    await t.backend.syncAccount(t.accounts[0]!);
    const settled = await t.backend.store.debug.snapshot();
    expect(settled.ops).toEqual([{ ...op!, state: "failed", attempts: 1 }]);
    expect(settled.messages.filter((m) => ids.includes(m.id)).map((m) => m.inInbox)).toEqual([...Array<boolean>(1000).fill(false), true]);
    expect(settled.messages.filter((m) => !ids.includes(m.id))).toEqual(t.siblings);
    expect(JSON.parse((await t.backend.store.ops.get(op!.id))!.target_json).messageIds).toEqual(ids);
    expect((await t.backend.store.providerStore(t.accounts[0]!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect(await t.backend.store.sync.pendingMessageIds(t.accounts[0]!)).toEqual(new Set());
    await t.reopen();
    expect((await t.backend.store.debug.snapshot()).ops).toEqual(settled.ops);
    expect(await t.backend.runWorker()).toBe(0);
    expect(await t.backend.store.ops.nextAttemptAt()).toBeNull();
    expect(t.mutations).toHaveLength(2);
    expect(t.mutations.every((m) => m.accountId === t.accounts[0] && !m.ids.includes("sibling"))).toBe(true);
  });

  it.each([204, 400])("older ACK status %s and captured history cannot erase newer independent versions", async (status) => {
    const t = await setup(kind, 2);
    const [older, latest] = t.selected, threadId = older!.threadId;
    const frozen = t.holdSnapshot("m0"), observation = t.backend.syncAccount(t.accounts[0]!);
    const held = t.holdMutation(1, status);
    let worker: Promise<number> | undefined;
    try {
      await frozen.entered.promise;
      expect(t.reads.at(-1)).toMatchObject({ id: "m0", labels: ["INBOX", "UNREAD"] });
      await t.client.call("threads.act", { threadIds: [threadId], action: "markRead" });
      worker = t.backend.runWorker(); await held.entered.promise;
      for (const action of ["markUnread", "star", "archive"] as const) await t.client.call("threads.act", { threadIds: [threadId], action });
      const queued = (await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued");
      expect(queued.find((op) => op.kind === "markUnread")?.messageIds).toEqual([latest!.id]);
      expect(queued.find((op) => op.kind === "star")?.messageIds).toEqual([latest!.id]);
      expect(queued.find((op) => op.kind === "archive")?.messageIds).toEqual([older!.id, latest!.id]);
      held.response.release(); expect(await worker).toBe(4);
      frozen.response.release(); await observation;
    } finally { held.response.release(); frozen.response.release(); await Promise.all([worker, observation]); }
    let snapshot = await t.backend.store.debug.snapshot();
    expect(snapshot.messages.find((m) => m.id === latest!.id)).toMatchObject({ isRead: false, isStarred: true, inInbox: false });
    expect(snapshot.ops.find((op) => op.kind === "markRead")).toMatchObject({ state: status === 204 ? "succeeded" : "failed", attempts: 1 });
    expect(snapshot.ops.filter((op) => op.kind !== "markRead").every((op) => op.state === "succeeded" && op.attempts === 1)).toBe(true);
    await t.reopen(); await t.drain(); await t.backend.syncAccount(t.accounts[0]!);
    snapshot = await t.backend.store.debug.snapshot();
    expect(snapshot.messages.find((m) => m.id === older!.id)).toMatchObject({ isRead: status === 204, isStarred: false, inInbox: false });
    expect(snapshot.messages.find((m) => m.id === latest!.id)).toMatchObject({ isRead: false, isStarred: true, inInbox: false });
    expect([...t.remote.get(t.accounts[0]!)!.get("m0")!].sort()).toEqual(status === 204 ? [] : ["UNREAD"]);
    expect([...t.remote.get(t.accounts[0]!)!.get("m1")!].sort()).toEqual(["STARRED", "UNREAD"]);
    expect(snapshot.messages.filter((m) => !t.selected.some((s) => s.id === m.id))).toEqual(t.siblings);
    expect((await t.backend.store.providerStore(t.accounts[0]!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    // A later external reversal is authoritative; a blanket optimistic reset would fail this control.
    t.remote.get(t.accounts[0]!)!.set("m1", new Set(["INBOX"]));
    await t.backend.syncAccount(t.accounts[0]!);
    expect((await t.backend.store.debug.snapshot()).messages.find((m) => m.id === latest!.id)).toMatchObject({ isRead: true, isStarred: false, inInbox: true });
  });

  it("captures shared-thread latest-message and received Restore scope without inheriting a late arrival", async () => {
    const t = await setup(kind, 2), accountId = t.accounts[0]!, threadId = t.selected[0]!.threadId;
    const sent = msg({ accountId, providerMsgId: "sent", providerThreadId: "shared", date: 1000, isSent: true, isRead: true, attachments: [], gmailLabels: ["INBOX", "SENT"] });
    t.remote.get(accountId)!.set("sent", new Set(["INBOX", "SENT"]));
    await t.backend.store.sync.ingest([sent], { applyFilters: false, now: 1, classifier: null });
    const sentId = (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "sent")!.id;
    for (const action of ["star", "markUnread"] as const) await t.client.call("threads.act", { threadIds: [threadId], action });
    expect((await t.backend.store.debug.snapshot()).ops.map((op) => [op.kind, op.messageIds])).toEqual([["star", [sentId]], ["markUnread", [sentId]]]);
    await t.drain();
    expect([...t.remote.get(accountId)!.get("sent")!].sort()).toEqual(["INBOX", "SENT", "STARRED", "UNREAD"]);
    await t.client.call("threads.act", { threadIds: [threadId], action: "archive" });
    const archive = (await t.backend.store.debug.snapshot()).ops.find((op) => op.kind === "archive")!;
    expect(archive.messageIds).toEqual([...t.selected.map((m) => m.id), sentId]);
    const late = msg({ accountId, providerMsgId: "late", providerThreadId: "shared", date: 2000, attachments: [], gmailLabels: ["INBOX", "UNREAD"] });
    t.remote.get(accountId)!.set("late", new Set(["INBOX", "UNREAD"]));
    await t.backend.store.sync.ingest([late], { applyFilters: false, now: 2, classifier: null });
    await t.drain();
    expect([...t.remote.get(accountId)!.get("late")!].sort()).toEqual(["INBOX", "UNREAD"]);
    expect(t.mutations.find((m) => m.remove.includes("INBOX"))?.ids).toEqual(["m0", "m1", "sent"]);
    await t.client.call("threads.act", { threadIds: [threadId], action: "moveToInbox" });
    const restore = (await t.backend.store.debug.snapshot()).ops.find((op) => op.kind === "moveToInbox")!;
    expect(restore.messageIds).toEqual(t.selected.map((m) => m.id));
    await t.drain(); await t.backend.syncAccount(accountId);
    const after = await t.backend.store.debug.snapshot();
    expect(after.messages.find((m) => m.id === sentId)).toMatchObject({ inInbox: false, isStarred: true, isRead: false, isSent: true });
    expect(after.messages.find((m) => m.providerMsgId === "late")).toMatchObject({ inInbox: true, isStarred: false, isRead: false });
    expect(after.messages.filter((m) => t.selected.some((s) => s.id === m.id)).every((m) => m.inInbox && !m.isStarred && !m.isRead)).toBe(true);
    expect(after.messages.filter((m) => t.siblings.some((s) => s.id === m.id))).toEqual(t.siblings);
    expect([...t.remote.get(accountId)!.get("sent")!].sort()).toEqual(["SENT", "STARRED", "UNREAD"]);
    expect(await t.backend.store.sync.pendingMessageIds(accountId)).toEqual(new Set());
  });

  it("later-slice local admission failure retains exact committed prefix and untouched remainder", async () => {
    const t = await setup(kind, 25, false), ids = t.selected.map((m) => m.id), threads = t.selected.map((m) => m.threadId);
    const act = t.backend.store.threads.act.bind(t.backend.store.threads), chunks: number[][] = [];
    const spy = vi.spyOn(t.backend.store.threads, "act").mockImplementation(async (input) => {
      chunks.push([...input.threadIds]);
      if (chunks.length === 2) throw new Error("Synthetic second admission refused before transaction");
      return act(input);
    });
    const outcome = await t.client.call("threads.act", { threadIds: threads, action: "archive" }).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    spy.mockRestore();
    expect(outcome.value).toBeNull(); expect(outcome.error).toMatchObject({ code: "INTERNAL" });
    expect(outcome.error).not.toHaveProperty("data.undoId");
    expect(chunks).toHaveLength(2); expect(chunks[0]).toEqual(threads.slice(0, 4));
    const before = await t.backend.store.debug.snapshot(), prefix = t.selected.slice(0, 4).map((m) => m.id);
    expect(before.messages.filter((m) => !m.inInbox).map((m) => m.id)).toEqual(prefix);
    expect(before.ops).toHaveLength(1);
    expect(before.ops[0]).toMatchObject({ state: "queued", attempts: 0, messageIds: prefix });
    expect(t.mutations).toEqual([]);
    await t.reopen(); expect((await t.backend.store.debug.snapshot()).ops).toEqual(before.ops);
    expect(await t.drain()).toBe(1); await t.backend.syncAccount(t.accounts[0]!);
    expect(t.mutations).toMatchObject([{ ids: t.selected.slice(0, 4).map((m) => m.providerMsgId), remove: ["INBOX"], applied: true }]);
    const persisted = await t.backend.store.debug.snapshot();
    expect(persisted.messages.filter((m) => !m.inInbox).map((m) => m.id)).toEqual(prefix);
    expect(persisted.messages.filter((m) => !ids.includes(m.id))).toEqual(t.siblings);
    // Explicit canonical restoration, rather than an invented partial-Undo token, recovers the admitted prefix.
    expect((await t.client.call("threads.act", { threadIds: threads, action: "moveToInbox" })).affected).toBe(4);
    await t.drain(); await t.backend.syncAccount(t.accounts[0]!);
    expect((await t.backend.store.debug.snapshot()).messages.every((m) => m.inInbox)).toBe(true);
    expect(await t.backend.store.ops.nextAttemptAt()).toBeNull();
  });
});
