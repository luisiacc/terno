// @vitest-environment jsdom
// The renderer's draft flows against a real backend and store, SQL and IndexedDB.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred, gate } from "./app-harness";
import { realSetup } from "./app-store-harness";

describe("canonical-only strip work", () => {
  for (const adapter of ["SQL", "IDB"] as const) it.each([undefined, false])(`${adapter}: canonical-only strip reply stays inline (intent ${"%s"})`, async (intent) => {
    const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
    try {
      const [a] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: a!, providerMsgId: "canonical", isRead: true, attachments: [] })]);
      const threadId = await threadOf(h.store, "canonical"), detail = (await h.store.threads.get(threadId))!;
      const saved = (await h.client.call("drafts.save", { accountId: a!, threadId, mode: "reply", ...(intent === undefined ? {} : { showSourceContext: intent }), bodyText: "exact canonical work" }))!;
      expect(saved).toMatchObject({ threadId, mode: "reply", inReplyToMessageId: null, showSourceContext: false }); await h.publish(saved);
      // read and cached: a slow machine reaches Reader's 40 ms hydration and its mark-read before the forced reload lands, each a threads.get of its own
      h.useThreads.setState((state) => ({ details: new Map(state.details).set(threadId, detail) }));
      gate.load.mockClear(); h.methods.length = 0;
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click()); for (let i = 0; i < 5; i++) await h.flush();
      expect(gate.load.mock.calls.filter(([, force]) => force)).toEqual([[threadId, true]]);
      expect(h.methods.filter((method) => method === "threads.get")).toHaveLength(1);
      expect(h.methods).not.toContain("drafts.sourceContext");
      expect(h.app.getApp().compose).toBeNull(); expect(h.app.getApp().selectedId).toBe(threadId);
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBe(h.key);
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: saved.id, generation: saved.generation, bodyText: saved.bodyText, mode: saved.mode, threadId });
    } finally { await h.cleanup(); }
  });


  for (const adapter of ["SQL", "IDB"] as const) it.each(["missing", "foreign", "wrong id"])(`${adapter}: canonical-only strip refuses ${"%s"} destination without changing stored work`, async (kind) => {
    const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
    try {
      const [a, b] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: a!, providerMsgId: "canonical", attachments: [] }), msg({ accountId: kind === "foreign" ? b! : a!, providerMsgId: "other", subject: "Other", attachments: [] })]);
      const threadId = await threadOf(h.store, "canonical"), otherId = await threadOf(h.store, "other"), original = (await h.store.threads.get(threadId))!;
      const saved = (await h.client.call("drafts.save", { accountId: a!, threadId, mode: "reply", bodyText: "exact canonical fallback", bodyHtml: "<div>exact canonical fallback</div>" }))!;
      await h.publish(saved);
      if (kind === "missing") await h.store.sync.remove(original.messages.map((m) => m.id));
      else {
        const other = (await h.store.threads.get(otherId))!;
        gate.load.mockImplementation(async (id: number) => {
          const detail = kind === "foreign" ? { ...other, thread: { ...other.thread, id } } : other;
          h.useThreads.setState((state) => ({ details: new Map(state.details).set(id, detail) })); return detail;
        });
      }
      gate.load.mockClear(); h.methods.length = 0;
      const before = h.drafts.materialize(h.key)!;
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click()); for (let i = 0; i < 5; i++) await h.flush();
      expect(gate.load.mock.calls.filter(([, force]) => force)).toEqual([[threadId, true]]); expect(h.methods).not.toContain("drafts.sourceContext");
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: before.revision, threadId, mode: "reply", bodyText: before.bodyText, bodyHtml: before.bodyHtml, showSourceContext: false });
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
      expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
    } finally { await h.cleanup(); }
  });
});

describe("source loss on acknowledgement", () => {
  for (const adapter of ["SQL", "IDB"] as const) it(`${adapter}: source-loss acknowledgement keeps departed work discoverable as standalone`, async () => {
    const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page");
    try {
      const [a, b] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: a!, providerMsgId: "original", rfcMessageId: "original@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "survives", references: ["original@example.test"], attachments: [] })]);
      const threadId = await threadOf(h.store, "original"), source = (await h.store.threads.get(threadId))!.messages.find((m) => m.rfcMessageId === "original@example.test")!;
      const ref = await h.store.attachments.create({ accountId: b!, filename: "authored-empty.txt", mime: "text/plain", size: 0, now: 0 }); await h.store.attachments.seal(b!, ref.assetId);
      const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "authored before deletion", attachments: [ref], to: [{ name: "Recipient", email: "recipient@example.test" }, { name: "", email: "bob@" }] }))!;
      await h.publish(saved);
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      await h.store.sync.remove([source.id]);
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: "exact latest retained work", bodyHtml: "<div>exact latest retained work</div>" }); await h.drafts.flushDraft(h.key); });
      const normalized = h.drafts.materialize(h.key)!;
      expect(normalized).toMatchObject({ mode: "new", inReplyToMessageId: null, forwardOfMessageId: null, showSourceContext: false, id: saved.id, generation: saved.generation, presentationThreadId: threadId, attachments: [ref] });
      await act(async () => closePage());
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      h.other.focus();
      const compose = await import("~/lib/compose"), originalOpen = compose.openCompose;
      let opening: Promise<void> | undefined;
      const observe = vi.spyOn(compose, "openCompose").mockImplementation((...args) => { opening = originalOpen(...args); return opening; });
      try {
        await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
        expect(opening).toBeDefined(); await act(async () => opening); for (let i = 0; i < 5; i++) await h.flush();
      } finally { observe.mockRestore(); }
      expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: normalized.revision, mode: "new", inReplyToMessageId: null, forwardOfMessageId: null, showSourceContext: false, bodyText: normalized.bodyText, bodyHtml: normalized.bodyHtml, toText: normalized.toText, attachments: [ref] });
    } finally { await h.cleanup(); }
  });
});

describe("dual-reference source loss", () => {
  for (const adapter of ["SQL", "IDB"] as const) for (const action of ["reply", "forward"] as const) it(`${adapter}: departed dual-reference source loss opens original work for ${action}`, async () => {
    const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page"), { openCompose, composeFocusPending } = await import("~/lib/compose");
    try {
      const [a, b] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: a!, providerMsgId: "original", rfcMessageId: "original@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "survives", references: ["original@example.test"], attachments: [] })]);
      const threadId = await threadOf(h.store, "original"), messages = (await h.store.threads.get(threadId))!.messages;
      const source = messages.find((m) => m.rfcMessageId === "original@example.test")!, opposite = messages.find((m) => m.rfcMessageId !== "original@example.test")!;
      const ref = await h.store.attachments.create({ accountId: b!, filename: "authored-empty.txt", mime: "text/plain", size: 0, now: 0 }); await h.store.attachments.seal(b!, ref.assetId);
      const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, forwardOfMessageId: opposite.id, showSourceContext: true, bodyText: "authored before deletion", attachments: [ref], to: [{ name: "Recipient", email: "recipient@example.test" }, { name: "", email: "bob@" }] }))!;
      expect(saved).toMatchObject({ mode: "reply", inReplyToMessageId: source.id, forwardOfMessageId: opposite.id, showSourceContext: true });
      await h.publish(saved);
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      await h.store.sync.remove([source.id]);
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: "exact latest retained work", bodyHtml: "<div>exact latest retained work</div>" }); await h.drafts.flushDraft(h.key); });
      const ack = h.drafts.materialize(h.key)!;
      expect(ack).toMatchObject({ mode: "reply", inReplyToMessageId: null, forwardOfMessageId: opposite.id, showSourceContext: false, id: saved.id, generation: saved.generation, presentationThreadId: threadId, attachments: [ref] });
      await act(async () => closePage());
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      h.other.focus();
      await act(async () => { await openCompose(action, threadId); });
      for (let i = 0; i < 10; i++) await h.flush();
      expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: ack.revision, mode: "reply", inReplyToMessageId: null, forwardOfMessageId: opposite.id, showSourceContext: false, bodyText: ack.bodyText, bodyHtml: ack.bodyHtml, toText: ack.toText, attachments: [ref], recovery: ack.recovery });
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(composeFocusPending(threadId)).toBe(false);
      expect(h.app.getApp().draftFocus).toBeNull();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    } finally { await h.cleanup(); }
  });

  for (const adapter of ["SQL", "IDB"] as const) it(`${adapter}: losing only the inactive reference keeps active Reply placement`, async () => {
    const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page"), { openCompose } = await import("~/lib/compose");
    try {
      const [a, b] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: a!, providerMsgId: "active", rfcMessageId: "active@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "inactive", references: ["active@example.test"], attachments: [] })]);
      const threadId = await threadOf(h.store, "active"), messages = (await h.store.threads.get(threadId))!.messages;
      const active = messages.find((m) => m.rfcMessageId === "active@example.test")!, inactive = messages.find((m) => m.id !== active.id)!;
      const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: active.id, forwardOfMessageId: inactive.id, showSourceContext: true, bodyText: "work retains active source", to: [{ name: "", email: "bob@" }] }))!;
      await h.publish(saved);
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      await h.store.sync.remove([inactive.id]);
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: "new exact active work", bodyHtml: "<p>new exact active work</p>" }); await h.drafts.flushDraft(h.key); });
      const ack = h.drafts.materialize(h.key)!;
      expect(ack).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", inReplyToMessageId: active.id, forwardOfMessageId: null, showSourceContext: true });
      await act(async () => closePage());
      await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
      h.other.focus(); await act(async () => { await openCompose("reply", threadId); });
      for (let i = 0; i < 10; i++) await h.flush();
      expect(h.app.getApp().compose).toBeNull();
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, h.app.getApp().draftShown)).toBe(h.key);
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: ack.revision, inReplyToMessageId: active.id, forwardOfMessageId: null, bodyText: ack.bodyText, bodyHtml: ack.bodyHtml, toText: ack.toText });
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await h.cleanup(); }
  });
});

describe("strip reopen of retained work", () => {
  for (const adapter of ["SQL", "IDB"] as const) it.each(["missing", "unknown", "refused", "removed From"])(`${adapter}: strip reopens retained ${"%s"} work without reviving its old target`, async (state) => {
    const h = await realSetup(adapter), { withAccounts } = await import("@terno/store/conformance"), { showNewDraft, leaveNewDraft, sendDraft } = await import("~/lib/compose");
    try {
      const [a, b] = await withAccounts(h.store);
      const saved = (await h.client.call("drafts.save", { accountId: a!, mode: "new", to: [{ name: "Recipient", email: "recipient@example.test" }, ...(state === "removed From" ? [] : [{ name: "", email: "bob@" }])], bodyText: "exact saved work", bodyHtml: "<div><b>exact saved work</b></div>" }))!;
      await h.publish(saved);
      await h.client.call("drafts.delete", { id: saved.id, generation: saved.generation! });
      if (state !== "removed From") {
        await act(async () => { h.drafts.editDraft(h.key, { bodyText: "latest retained work", bodyHtml: "<div><b>latest retained work</b></div>" }); await h.drafts.flushDraft(h.key); });
        expect(h.drafts.useDrafts.getState().drafts[h.key]?.recovery?.state).toBe("missing");
        if (state === "unknown") {
          h.drafts.setDraftTransport(async (method, p) => { if (method === "drafts.save") { await h.call(method, h.contract[method].params.parse(p)); throw new Error("acknowledgement lost"); } return h.call(method, h.contract[method].params.parse(p)); });
          await act(async () => h.drafts.copyDraft(h.key));
        }
        if (state === "refused") { await h.store.accounts.remove(a!); await act(async () => h.drafts.copyDraft(h.key)); }
        expect(h.drafts.useDrafts.getState().drafts[h.key]?.recovery?.state).toBe(state);
      } else await h.store.accounts.remove(a!);
      await act(async () => { h.app.setApp({ accounts: await h.store.accounts.list(), accountId: b! }); showNewDraft(h.key); });
      await act(async () => leaveNewDraft());
      const before = h.drafts.materialize(h.key)!;
      const rows = (await h.store.drafts.list()).length; h.methods.length = 0;
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
      expect(h.app.getApp().compose?.key).toBe(h.key);
      expect(h.host.querySelector('[data-testid="composer"]')).not.toBeNull();
      if (state !== "removed From") { const action = h.host.querySelector<HTMLButtonElement>('[data-testid="draft-save-copy"]')!; expect(action).not.toBeNull(); expect(action.tabIndex).toBeGreaterThanOrEqual(0); }
      else expect(h.host.querySelector('[data-testid="compose-from"]')).not.toBeNull();
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml, toText: before.toText });
      expect(h.drafts.materialize(h.key)?.recovery).toEqual(before.recovery);
      await act(async () => { expect(await sendDraft(h.key)).toBe(false); });
      expect(h.methods.filter((method) => ["drafts.save", "drafts.delete", "compose.send"].includes(method))).toEqual([]);
      expect((await h.store.drafts.list()).length).toBe(rows);
    } finally { await h.cleanup(); }
  });



  it("valid-recipient removed-From work refuses Send locally before a submission RPC", async () => {
    const h = await realSetup("SQL"), { withAccounts } = await import("@terno/store/conformance"), { showNewDraft, sendDraft } = await import("~/lib/compose");
    try {
      const [a, b] = await withAccounts(h.store);
      const saved = (await h.client.call("drafts.save", { accountId: a!, to: [{ name: "Recipient", email: "recipient@example.test" }], bodyText: "exact local work" }))!;
      await h.publish(saved); await h.store.accounts.remove(a!);
      await act(async () => { h.app.setApp({ accounts: await h.store.accounts.list(), accountId: b! }); showNewDraft(h.key); });
      h.methods.length = 0;
      expect(h.drafts.materialize(h.key)?.recovery).toBeUndefined();
      await act(async () => { expect(await sendDraft(h.key)).toBe(false); });
      expect(h.methods).not.toContain("compose.send");
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, accountId: a!, bodyText: saved.bodyText });
    } finally { await h.cleanup(); }
  });
});

describe("list selection handoff", () => {
  async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`phase deadline: ${label}`)), 15000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  it.each(["passive", "later user"] as const)("preserves draft ownership during a gated first-page completion: %s", async (scenario) => {
    const phase = (name: string) => console.log(`oracle ${scenario}: ${name}`);
    phase("setup start");
    const { useApp } = await import("~/state/app");
    const { useList, listKey } = await import("~/state/list");
    const originalApp = useApp.getState(), originalList = useList.getState();
    const originalHistory = history.state, originalUrl = location.href;
    const h = await realSetup("SQL");
    const { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
    const { pressRow } = await import("~/lib/select");
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const listGate = deferred<void>(), sourceGate = deferred<void>(), listStarted = deferred<void>(), sourceStarted = deferred<void>(), listDelivered = deferred<void>();
    const later = document.createElement("button"); document.body.append(later);
    let armed = false, listCount = 0, sourceCount = 0, firstPage: { items: { id: number }[] } | undefined;
    let requestScope: unknown, requestKey = "", selectedAtStart: number | null = null;
    let opening: Promise<void> | undefined;
    try {
      phase("setup complete");
      const [account, foreign] = await withAccounts(h.store);
      await ingest(h.store, [msg({ accountId: account!, providerMsgId: "oracle-source", attachments: [] }), msg({ accountId: account!, providerMsgId: "oracle-newer", attachments: [] })]);
      const threadId = await threadOf(h.store, "oracle-source"), otherId = await threadOf(h.store, "oracle-newer");
      const detail = (await h.store.threads.get(threadId))!, source = detail.messages[0]!;
      const draft = (await h.client.call("drafts.save", { accountId: foreign!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "exact oracle body", bodyHtml: "<div><b>exact oracle body</b></div>" }))!;
      await h.publish(draft);
      await act(async () => { h.app.setApp({ view: "inbox" }); h.useThreads.setState({ details: new Map([[threadId, detail]]) }); h.drafts.expireDraftPresentation(threadId); });
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      expect(before.presentationExpired).toBe(true);
      const previousKey = "oracle-prior-list-generation";
      useList.setState({ key: previousKey });
      gate.call.mockImplementation((method: string, params: unknown) => {
        if (armed && method === "threads.list") {
          listCount++; requestScope = params; requestKey = listKey(); selectedAtStart = h.app.getApp().selectedId;
          const actual = h.call("threads.list", params as Parameters<typeof h.client.call<"threads.list">>[1]);
          listStarted.resolve();
          return actual.then(async (page) => { firstPage = page; await listGate.promise; return page; }).finally(() => listDelivered.resolve());
        }
        if (armed && method === "drafts.sourceContext") {
          sourceCount++; const actual = h.call("drafts.sourceContext", params as Parameters<typeof h.client.call<"drafts.sourceContext">>[1]);
          sourceStarted.resolve(); return actual.then(async (context) => { await sourceGate.promise; return context; });
        }
        return h.call(method as keyof typeof h.contract, params as never);
      });
      armed = true;
      phase("arm first page");
      await act(async () => { h.app.setApp({ view: "all", accountId: account!, selectedId: null, readerOpen: false }); await bounded(listStarted.promise, "first page start"); });
      phase("first page started");
      expect(listCount).toBe(1); expect(requestScope).toMatchObject({ view: "all", accountId: account });
      expect(requestKey).not.toBe(previousKey); expect(useList.getState().key).toBe(requestKey); expect(selectedAtStart).toBeNull();
      await act(async () => { pressRow(threadId, { meta: false, ctrl: false, shift: false }); h.app.setApp({ readerOpen: true }); });
      expect(h.app.getApp().selectedId).toBe(threadId);
      await h.store.sync.remove([source.id]);
      h.other.focus();
      // (arriving asks too, plan 158: this counts the open's own)
      sourceCount = 0;
      await act(async () => { opening = openCompose("forward", threadId); await bounded(sourceStarted.promise, "source lookup start"); });
      phase("source lookup held");
      expect(sourceCount).toBe(1); expect(composeFocusPending(threadId)).toBe(true);
      expect(h.app.getApp().selectedId).toBe(threadId);
      if (scenario === "later user") await act(async () => { pressRow(otherId, { meta: false, ctrl: false, shift: false }); later.focus(); });
      await act(async () => { listGate.resolve(); await Promise.resolve(); await Promise.resolve(); });
      phase("first page released");
      expect(listCount).toBe(1); expect(firstPage?.items[0]?.id).toBe(otherId);
      expect(h.app.getApp().selectedId).toBe(scenario === "passive" ? threadId : otherId);
      await act(async () => { sourceGate.resolve(); await bounded(opening!, "compose completion"); });
      phase("source released");
      for (let i = 0; i < 5; i++) await h.flush();
      const after = h.drafts.useDrafts.getState().drafts[h.key]!;
      expect(after).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
      if (scenario === "passive") expect(h.app.getApp().compose?.key).toBe(h.key);
      else { expect(h.app.getApp().compose).toBeNull(); expect(document.activeElement).toBe(later); expect(composeFocusPending(threadId)).toBe(false); }
    } finally {
      phase("cleanup start");
      listGate.resolve(); sourceGate.resolve(); listStarted.resolve(); sourceStarted.resolve();
      try {
        if (opening) await bounded(opening, "cleanup compose");
      } finally {
        try { if (listCount) await bounded(listDelivered.promise, "cleanup list"); }
        finally {
          later.remove();
          try { await bounded(h.cleanup(), "cleanup fixture"); }
          finally { useApp.setState(originalApp, true); useList.setState(originalList, true); history.replaceState(originalHistory, "", originalUrl); }
          phase("cleanup complete");
        }
      }
    }
  });
});
