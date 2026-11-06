// @vitest-environment jsdom
// A draft's presentation: stored, standalone and converted work keep identity, destination and focus.
import type { ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { StrictMode, act } from "react";
import { describe, expect, it } from "vitest";
import type { DraftAckRead } from "../lib/drafts";
import { deferred, gate, setup } from "./app-harness";

describe("standalone eligibility", () => {
  it.each(["edit", "leave"] as const)("a later %s cancels initially collapsed standalone focus", async (scenario) => {
    const h = await setup("split", true);
    const { openStoredDraft, composeFocusPending } = await import("~/lib/compose");
    const { newFields } = await import("~/lib/compose-fields");
    try {
      let key = "";
      await act(async () => {
        key = h.drafts.createDraft({ ...newFields(1), bodyText: "retained", uiState: "collapsed" });
        h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "retained", revision: 4, status: "saved" } } }));
        h.drafts.expireDraftPresentation(7);
      });
      gate.call.mockResolvedValue(null); h.other.focus();
      await act(async () => { await openStoredDraft(key); });
      const seq = h.app.getApp().compose?.storedFocusSeq;
      expect(seq).toBeDefined(); expect(composeFocusPending(null, key, seq)).toBe(true);
      if (scenario === "edit") await act(async () => { h.drafts.editDraft(key, { bodyText: "later edit" }); });
      else await act(async () => { h.host.querySelector<HTMLElement>('[data-testid="compose-to"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(composeFocusPending(null, key, seq)).toBe(false);
      for (let i = 0; i < 5; i++) await h.flush();
      if (scenario === "edit") expect(document.activeElement).toBe(h.other);
      else expect(h.app.getApp().compose).toBeNull();
      expect(h.drafts.materialize(key)?.bodyText).toBe(scenario === "edit" ? "later edit" : "retained");
    } finally { await h.cleanup(); }
  });
});

describe("standalone Escape", () => {
  it.each(["successor", "ordinary"] as const)("standalone Escape respects a later Forward: %s", async (scenario) => {
    const h = await setup("split", true), waiting = deferred<ThreadDetail>(), save = deferred<void>(), { showNewDraft, openCompose, composeFocusPending } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields");
    let key = "", newer: Promise<void> | undefined, triggered = false;
    try {
      await act(async () => { key = h.drafts.createDraft({ ...newFields(1), bodyText: "standalone work" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "standalone", revision: 5, status: "saved" } } })); showNewDraft(key); });
      h.drafts.setDraftTransport(async (_method, p) => { await save.promise; return { ...(p as object), id: 82, generation: "standalone", revision: 6, updatedAt: 0 }; });
      for (let i = 0; i < 4; i++) await h.flush();
      const input = h.host.querySelector<HTMLElement>('[data-testid="compose-to"]'); expect(input).not.toBeNull(); input!.focus(); gate.load.mockReturnValue(waiting.promise);
      const off = h.app.useApp.subscribe((s, prev) => { if (!triggered && prev.compose?.key === key && !s.compose) { triggered = true; if (scenario === "successor") newer = openCompose("forward", 7); } });
      try {
        await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
        expect(triggered).toBe(true);
        if (scenario === "successor") { expect(newer).toBeDefined(); expect(composeFocusPending(7)).toBe(true); }
        await h.flush();
        if (scenario === "successor") { expect(composeFocusPending(7)).toBe(true); await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await newer; }); for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]')); }
        else expect(document.activeElement).toBe(h.host.querySelector(`[data-testid="strip-item"][data-key="${key}"]`));
        expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ id: 82, generation: "standalone", bodyText: "standalone work" });
      } finally { off(); }
    } finally { waiting.resolve(h.detail); if (newer) await newer; save.resolve(); if (key) await act(async () => { await h.drafts.flushDraft(key); }); h.drafts.setDraftTransport((method, p) => gate.call(method, p)); await h.cleanup(); }
  });
});

describe("standalone handoff", () => {
  it.each(["stay", "move", "round trip"] as const)("transfers an expired draft to standalone while preserving focus choice: %s", async (scenario) => {
    const h = await setup("split", true);
    const { openCompose, composeFocusPending } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let triggered = false;
    try {
      await act(async () => { h.drafts.expireDraftPresentation(7); });
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.presentationExpired).toBe(true);
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
          triggered = true;
          if (scenario !== "stay") { later.focus(); if (scenario === "round trip") h.other.focus(); }
        }
      });
      try {
        await act(async () => { await openCompose("forward", 7); });
        expect(triggered).toBe(true);
        for (let i = 0; i < 15; i++) await h.flush();
        if (scenario === "stay") {
          expect(h.app.getApp().compose?.key).toBe(h.key);
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
        } else {
          expect(document.activeElement).toBe(scenario === "move" ? later : h.other);
          expect(h.app.getApp().draftFocus).toBeNull();
          expect(composeFocusPending(7)).toBe(false);
        }
        expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toBe("exact authored work");
      } finally { off(); }
    } finally { later.remove(); await h.cleanup(); }
  });

  it("does not let a standalone transfer replace a newer compose intent during invalidation", async () => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose");
    let newer: Promise<void> | undefined, triggered = false;
    try {
      await act(async () => h.drafts.expireDraftPresentation(7));
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
          triggered = true; newer = openCompose("new", null);
        }
      });
      try {
        await act(async () => { await openCompose("forward", 7); if (newer) await newer; });
        expect(triggered).toBe(true);
        expect(h.app.getApp().compose?.key).toBeDefined();
        expect(h.app.getApp().compose?.key).not.toBe(h.key);
        for (let i = 0; i < 15; i++) await h.flush();
        expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
        expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toBe("exact authored work");
      } finally { off(); }
    } finally { if (newer) await newer; await h.cleanup(); }
  });

  it.each(["stay", "move", "round trip"] as const)("preserves an unleased off-selection transfer's focus choice: %s", async (scenario) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    let triggered = false;
    try {
      await act(async () => { h.drafts.expireDraftPresentation(7); h.app.setApp({ selectedId: 8 }); });
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && (state.drafts[h.key]?.presentationEpoch ?? 0) > (previous.drafts[h.key]?.presentationEpoch ?? 0)) {
          triggered = true;
          if (scenario !== "stay") { later.focus(); if (scenario === "round trip") h.other.focus(); }
        }
      });
      try {
        await act(async () => { await openCompose("forward", 7); });
        expect(triggered).toBe(true);
        for (let i = 0; i < 15; i++) await h.flush();
        if (scenario === "stay") {
          expect(h.app.getApp().compose?.key).toBe(h.key);
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
        } else {
          expect(document.activeElement).toBe(scenario === "round trip" ? h.other : later);
          expect(h.app.getApp().draftFocus).toBeNull();
        }
      } finally { off(); }
    } finally { later.remove(); await h.cleanup(); }
  });

  it("notifies a deferred Reader when acquisition stops on a release-time focus choice", async () => {
    const h = await setup("split", true);
    const { openCompose, subscribeComposeFocus } = await import("~/lib/compose");
    const later = document.createElement("button"); document.body.append(later);
    const notices: boolean[] = [];
    const unsubscribe = subscribeComposeFocus((threadId, fallback) => { if (threadId === 7) notices.push(fallback); });
    let triggered = false;
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      h.other.focus();
      await act(async () => {
        void openCompose("reply", 7);
        const off = h.app.useApp.subscribe((state, previous) => {
          if (!triggered && previous.draftFocus && !state.draftFocus) { triggered = true; off(); later.focus(); }
        });
        void openCompose("reply", 7); off();
      });
      expect(triggered).toBe(true);
      expect(notices).toEqual([false]);
      await h.flush(); expect(document.activeElement).toBe(later);
    } finally { unsubscribe(); later.remove(); await h.cleanup(); }
  });
});

describe("standalone invalidation", () => {
  it.each(["round trip", "same id", "later destination", "publication destination", "ordinary"] as const)("standalone invalidation respects intervening selection: %s", async (scenario) => {
    const h = await setup("split", true), { openStoredDraft, showNewDraft, composeFocusPending } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select"), { newFields } = await import("~/lib/compose-fields");
    let d = "", e = "", triggered = false;
    try {
      await act(async () => { d = h.drafts.createDraft({ ...newFields(1), bodyText: "original standalone" }); e = h.drafts.createDraft({ ...newFields(1), bodyText: "later standalone" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [d]: { ...s.drafts[d]!, id: 82, generation: "standalone", revision: 5, status: "saved" } } })); });
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && (state.drafts[d]?.presentationEpoch ?? 0) > (previous.drafts[d]?.presentationEpoch ?? 0)) {
          triggered = true;
          if (scenario === "round trip") { pressRow(8, { shift: false, meta: false, ctrl: false }); pressRow(7, { shift: false, meta: false, ctrl: false }); }
          else if (scenario === "same id") pressRow(7, { shift: false, meta: false, ctrl: false });
          else if (scenario === "later destination") showNewDraft(e);
        }
      });
      const offApp = h.app.useApp.subscribe((state) => { if (scenario === "publication destination" && state.compose?.key === d) showNewDraft(e); });
      try {
        await act(async () => { await openStoredDraft(d); });
        expect(triggered).toBe(true);
        expect(h.drafts.materialize(d)).toMatchObject({ id: 82, generation: "standalone", revision: 5, bodyText: "original standalone" }); expect(h.drafts.materialize(e)?.bodyText).toBe("later standalone");
        if (scenario === "ordinary") expect(h.app.getApp().compose?.key).toBe(d);
        else { expect(h.app.getApp().compose?.key ?? null).toBe(scenario === "later destination" || scenario === "publication destination" ? e : null); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(null)).toBe(false); }
      } finally { off(); offApp(); }
    } finally { await h.cleanup(); }
  });
});

describe("standalone transition history", () => {
  it.each(["restored account", "publication restored", "ordinary"] as const)("standalone retains transition history: %s", async (scenario) => {
    const h = await setup("split", true), { openStoredDraft, composeFocusPending } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields");
    let key = "", triggered = false, restored = false, published = false;
    try {
      await act(async () => { key = h.drafts.createDraft({ ...newFields(1), bodyText: "saved original", bodyHtml: "<p>saved original</p>" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 82, generation: "stable-standalone", revision: 5, status: "saved" } } })); });
      h.other.focus(); const revision = h.app.getSelectionWriteRevision();
      const restorer = h.app.useApp.subscribe((s, prev) => { if (scenario !== "ordinary" && !restored && prev.accountId === 1 && s.accountId === 2) { restored = true; h.app.setApp({ accountId: 1 }); } });
      const publish = h.app.useApp.subscribe((s) => { if (scenario === "publication restored" && !published && s.compose?.key === key) { published = true; h.app.setApp({ accountId: 2 }); } });
      const off = h.drafts.useDrafts.subscribe((s, prev) => { if (!triggered && (s.drafts[key]?.presentationEpoch ?? 0) > (prev.drafts[key]?.presentationEpoch ?? 0)) { triggered = true; if (scenario === "restored account") h.app.setApp({ accountId: 2 }); } });
      try {
        await act(async () => { await openStoredDraft(key); });
        expect(triggered).toBe(true); expect(restored).toBe(scenario !== "ordinary");
        expect(h.app.getApp()).toMatchObject({ accountId: 1, selectedId: 7 });
        expect(h.app.getSelectionWriteRevision()).toBe(revision + 1);
        expect(h.drafts.materialize(key)).toMatchObject({ id: 82, generation: "stable-standalone", revision: 5, bodyText: "saved original", bodyHtml: "<p>saved original</p>" });
        if (scenario === "ordinary") expect(h.app.getApp().compose?.key).toBe(key);
        else { expect(h.app.getApp().compose).toBeNull(); expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(null)).toBe(false); }
      } finally { off(); publish(); restorer(); }
    } finally { await h.cleanup(); }
  });
});

describe("stored navigation", () => {
  it.each(["round trip", "ordinary"] as const)("stored navigation preserves nested selection choice: %s", async (scenario) => {
    const h = await setup("split", true), { openStoredDraft, composeFocusPending } = await import("~/lib/compose"), { pressRow } = await import("~/lib/select");
    let triggered = false;
    try {
      h.other.focus();
      const off = h.app.useApp.subscribe((state, previous) => {
        if (!triggered && state.checked !== previous.checked && state.readerOpen && state.selectedId === 7) {
          triggered = true;
          if (scenario === "round trip") {
            pressRow(8, { shift: false, meta: false, ctrl: false });
            pressRow(7, { shift: false, meta: false, ctrl: false });
          }
        }
      });
      try {
        await act(async () => { await openStoredDraft(h.key); });
        expect(triggered).toBe(true);
        if (scenario === "round trip") {
          expect(h.app.getApp().draftFocus).toBeNull();
          expect(composeFocusPending(7)).toBe(false);
        } else {
          for (let i = 0; i < 5; i++) await h.flush();
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
        }
        expect(h.drafts.materialize(h.key)?.bodyText).toBe("exact authored work");
      } finally { off(); }
    } finally { await h.cleanup(); }
  });
});

describe("stored-open account history", () => {
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
});

describe("stored origin", () => {
  it.each(["control", "keyboard"])("stored origin revoked before the first NewMessage effect stays cancelled (%s)", async (kind) => {
    const h = await setup("split", true), newerSource = deferred<{ threadId: number; accountId: number }>();
    const { composeFocusPending } = await import("~/lib/compose");
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    const off = h.app.useApp.subscribe((state) => {
      if (state.draftFocus?.key !== h.key || state.compose?.key !== h.key) return;
      off();
      if (kind === "control") h.other.focus();
      else {
        gate.call.mockImplementation((method: string) => method === "drafts.sourceContext" ? newerSource.promise : Promise.resolve({}));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
      }
    });
    try {
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
      for (let i = 0; i < 15; i++) await h.flush();
      if (kind === "control") expect(document.activeElement).toBe(h.other);
      else { expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull(); expect(composeFocusPending(7)).toBe(true); }
    } finally { off(); newerSource.resolve({ threadId: 7, accountId: 1 }); await act(async () => {}); await h.cleanup(); }
  });

  it("stored standalone source mutation during publication cannot retain focus permission", async () => {
    const h = await setup("split", true);
    gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? null : {});
    const off = h.app.useApp.subscribe((state) => {
      if (state.compose?.key !== h.key) return;
      off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "newer source work" });
    });
    try {
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
      for (let i = 0; i < 15; i++) await h.flush();
      expect(document.activeElement?.closest('[data-testid="composer"]')).toBeNull();
      expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", inReplyToMessageId: 4, showSourceContext: true, bodyText: "newer source work" });
    } finally { off(); await h.cleanup(); }
  });
});

describe("stored source publication", () => {
  it.each(["invalidate", "validate"])("stored publication cannot adopt another active source at %s", async (publication) => {
    const h = await setup("list");
    gate.call.mockImplementation(async (method: string, p: { messageId: number }) => method === "drafts.sourceContext" ? { threadId: p.messageId === 3 ? 7 : 8, accountId: 1 } : {});
    const off = h.drafts.useDrafts.subscribe((state, before) => {
      const next = state.drafts[h.key], previous = before.drafts[h.key];
      if (!next || !previous) return;
      const hit = publication === "invalidate" ? !previous.presentationExpired && next.presentationExpired : previous.presentationExpired && !next.presentationExpired;
      if (hit) { off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "latest S2 work" }); }
    });
    try {
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
      for (let i = 0; i < 5; i++) await h.flush();
      expect(h.app.getApp().draftShown?.key).not.toBe(h.key);
      expect(h.app.getApp().draftFocus).toBeNull();
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ inReplyToMessageId: 4, bodyText: "latest S2 work", showSourceContext: true, id: 81, generation: "stable" });
      if (publication === "invalidate") expect(gate.load).not.toHaveBeenCalled();
    } finally { off(); await h.cleanup(); }
  });

  it("stored open rejects a baseline changed synchronously by materializing its editor", async () => {
    const h = await setup("list"), source = h.drafts.attachBody(h.key, () => ({ text: "materialized S1 body", html: "<div>materialized S1 body</div>" }));
    source.changed();
    const off = h.drafts.useDrafts.subscribe((state, before) => {
      if (state.drafts[h.key]?.bodyText === before.drafts[h.key]?.bodyText) return;
      off(); h.drafts.editDraft(h.key, { inReplyToMessageId: 4, showSourceContext: true, bodyText: "latest S2 work" });
    });
    try {
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
      for (let i = 0; i < 5; i++) await h.flush();
      expect(gate.call.mock.calls.filter(([method]) => method === "drafts.sourceContext")).toEqual([]);
      expect(h.app.getApp().draftShown?.key).not.toBe(h.key);
      expect(h.drafts.materialize(h.key)).toMatchObject({ inReplyToMessageId: 4, bodyText: "latest S2 work", id: 81, generation: "stable" });
    } finally { off(); source.dispose(); await h.cleanup(); }
  });
});

describe("presentation lifetime", () => {
  it("List Back expires the actual Reader while preserving identity and work", async () => {
    const h = await setup("list", true), { closePage, openThread } = await import("~/lib/page");
    try {
      expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
      await act(async () => closePage());
      expect(h.host.querySelector('[data-testid="reader"]')).toBeNull(); expect(h.app.getApp().selectedId).toBe(7);
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBeNull();
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: 81, generation: "stable", revision: 4, bodyText: "exact authored work" });
      await act(async () => openThread(7));
      expect(h.host.querySelector('[data-draft-key]')).toBeNull();
    } finally { await h.cleanup(); }
  });
  it("Split readerOpen false and same-thread Strict replacement retain a mounted draft", async () => {
    const h = await setup("split", true);
    try {
      await act(async () => h.app.setApp({ readerOpen: false }));
      expect(h.host.querySelector('[data-testid="reader"]')).not.toBeNull();
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBe(h.key);
      await act(async () => h.root.render(<StrictMode><h.App key="replacement" /></StrictMode>));
      expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, 7, null)).toBe(h.key);
    } finally { await h.cleanup(); }
  });
});

describe("list destination intent", () => {
  it.each(["new", "stored standalone", "show stored", "reply"] as const)("keeps %s when an older first page completes", async (scenario) => {
    const h = await setup("list", true);
    const { useList, reloadList } = await import("~/state/list");
    const { openCompose, showNewDraft } = await import("~/lib/compose");
    const waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
    const source = deferred<{ threadId: number; accountId: number }>();
    const next = { ...h.detail.thread, id: 8 };
    let opening: Promise<void> | undefined;
    try {
      useList.setState({ key: "prior-view" });
      gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : method === "drafts.sourceContext" ? (scenario === "reply" ? source.promise : Promise.resolve(null)) : Promise.resolve({}));
      const page = reloadList();
      try {
        expect(gate.call).toHaveBeenCalledWith("threads.list", expect.anything());
        if (scenario === "new") {
          await act(async () => { await openCompose("new", null); });
          expect(h.app.getApp().compose?.key).toBeDefined();
        } else if (scenario === "stored standalone") {
          const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
          expect(button).not.toBeNull(); button.focus(); await act(async () => button.click());
          expect(h.app.getApp().compose?.key).toBe(h.key);
        } else if (scenario === "show stored") {
          await act(async () => showNewDraft(h.key));
          expect(h.app.getApp().compose?.key).toBe(h.key);
        } else {
          h.other.focus(); await act(async () => { opening = openCompose("reply", 7); });
          expect(gate.call).toHaveBeenCalledWith("drafts.sourceContext", { messageId: 3 });
        }
        const selected = h.app.getApp().selectedId, compose = h.app.getApp().compose;
        await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await page; });
        expect(h.app.getApp().selectedId).toBe(selected);
        if (scenario === "new" || scenario === "stored standalone" || scenario === "show stored") expect(h.app.getApp().compose).toBe(compose);
        if (scenario === "reply") {
          await act(async () => { source.resolve({ threadId: 7, accountId: 1 }); await opening; });
          for (let i = 0; i < 5; i++) await h.flush();
          expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
        }
      } finally { waiting.resolve({ items: [next], nextCursor: null }); source.resolve({ threadId: 7, accountId: 1 }); await page; if (opening) await opening; }
    } finally { await h.cleanup(); }
  });
});

describe("Reader Back and the list's first page", () => {
  it("keeps the selected thread when Reader toolbar Back precedes an older first page", async () => {
    const h = await setup("list", true), waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
    const { useList, reloadList } = await import("~/state/list");
    const next = { ...h.detail.thread, id: 8 };
    try {
      useList.setState({ key: "prior-view" });
      gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : Promise.resolve({}));
      const page = reloadList();
      try {
        expect(gate.call).toHaveBeenCalledWith("threads.list", expect.anything());
        const button = h.host.querySelector<HTMLButtonElement>('[data-testid="reader-back"]')!;
        expect(button).not.toBeNull(); await act(async () => button.click());
        expect(h.app.getApp().readerOpen).toBe(false);
        await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await page; });
        expect(h.app.getApp().selectedId).toBe(7);
      } finally { waiting.resolve({ items: [next], nextCursor: null }); await page; }
    } finally { await h.cleanup(); }
  });

  it("lets a new-view first page select its first row after automatic page closure", async () => {
    const h = await setup("list", true), waiting = deferred<{ items: typeof h.detail.thread[]; nextCursor: null }>();
    const { useList } = await import("~/state/list");
    const next = { ...h.detail.thread, id: 8 };
    let resolve!: () => void; const finished = new Promise<void>((done) => { resolve = done; });
    const off = useList.subscribe((state, previous) => { if (previous.loading && !state.loading) resolve(); });
    try {
      useList.setState({ key: "prior-view" });
      gate.call.mockImplementation((method: string) => method === "threads.list" ? waiting.promise : Promise.resolve({}));
      await act(async () => h.app.setApp({ view: "all", selectedId: null }));
      expect(h.app.getApp().readerOpen).toBe(false);
      await act(async () => { waiting.resolve({ items: [next], nextCursor: null }); await finished; });
      expect(h.app.getApp().selectedId).toBe(8);
    } finally { off(); waiting.resolve({ items: [next], nextCursor: null }); await h.cleanup(); }
  });
});

describe("mail landmarks", () => {
  it("keeps one main and the same list DOM, focus and scroll through layouts and covered pages", async () => {
    const h = await setup("list", true);
    const { useAppearance } = await import("~/lib/appearance");
    const mains = () => h.host.querySelectorAll('main, [role="main"]');
    const list = h.host.querySelector<HTMLElement>("#app-list")!;
    const section = h.host.querySelector<HTMLElement>("[data-list-section]")!;
    const draft = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
    const sameList = () => {
      expect(h.host.querySelector("#app-list")).toBe(list);
      expect(h.host.querySelector("[data-list-section]")).toBe(section);
      expect(h.host.querySelector('[data-testid="strip-item"]')).toBe(draft);
      expect(section.scrollTop).toBe(128);
      expect(mains()).toHaveLength(1);
      expect(mains()[0]!.querySelector('main, [role="main"]')).toBeNull();
    };
    try {
      section.scrollTop = 128; draft.focus();
      expect(mains()).toHaveLength(1);
      expect(mains()[0]).toBe(list);
      await act(async () => useAppearance.setState({ layout: "split" }));
      sameList();
      expect(list.getAttribute("aria-label")).toBe(t("list.label"));
      expect(list.contains(mains()[0]!)).toBe(false);
      expect(document.activeElement).toBe(draft);
      await act(async () => useAppearance.setState({ layout: "list" }));
      sameList();
      expect(document.activeElement).toBe(draft);
      expect(mains()[0]).toBe(list);
      for (const page of ["thread", "compose"] as const) {
        await act(async () => h.app.setApp({ readerOpen: true, compose: page === "compose" ? { key: h.key, seq: 0 } : null }));
        sameList();
        expect(section.hasAttribute("inert")).toBe(true);
        expect(mains()[0]!.contains(h.host.querySelector('[data-testid="list-page"]'))).toBe(true);
        expect(h.host.querySelector('[data-testid="list-page"]')?.getAttribute("data-page")).toBe(page);
      }
      await act(async () => h.app.setApp({ compose: null, readerOpen: false }));
      sameList();
      expect(section.hasAttribute("inert")).toBe(false);
    } finally { await h.cleanup(); }
  });
});

describe("openCompose's outcome", () => {
  // plan 57: an open that still matters never ends in silence
  const opened = (h: Awaited<ReturnType<typeof setup>>) => Object.values(h.drafts.useDrafts.getState().drafts).filter((d) => d.mode === "reply" && d.inReplyToMessageId === 3);

  // plan 133 §5.2: the seam names where it landed, and says so before anything takes focus
  it("composeLanding names the draft it made, resumed, converted or was sent to; a superseded one lands nowhere", async () => {
    const h = await setup("split", true);
    const { composeLanding, openCompose } = await import("~/lib/compose"), { pinDraft, unpinDraft } = await import("~/lib/pinned-draft");
    try {
      h.drafts.forgetDraft(h.key);
      const told: string[] = [];
      const landing = async (open: () => ReturnType<typeof composeLanding>) => {
        const out: { landed?: Awaited<ReturnType<typeof composeLanding>> } = {};
        await act(async () => { out.landed = await open(); });
        await h.flush();
        return out.landed;
      };
      const created = await landing(() => composeLanding("reply", 7, 0, undefined, undefined, { onLanded: (l) => told.push(`${l.kind}:${l.key}`) }));
      expect(created).toMatchObject({ kind: "created" });
      const key = (created as { key: string }).key;
      expect(told).toEqual([`created:${key}`]);
      expect(opened(h).map((d) => d.key)).toEqual([key]);
      expect(await landing(() => composeLanding("reply", 7))).toEqual({ kind: "resumed", key });
      expect(await landing(() => composeLanding("replyAll", 7))).toEqual({ kind: "converted", key });

      await act(async () => { pinDraft(key); });
      expect(await landing(() => composeLanding("reply", 7))).toEqual({ kind: "pinned", key });
      await act(async () => { unpinDraft(key, { focus: false }); });

      expect(await landing(() => {
        const first = composeLanding("reply", 8);
        void openCompose("new");
        return first;
      })).toEqual({ kind: "none" });
    } finally { await h.cleanup(); }
  });

  it("a refresh that replaces the conversation mid-open is retried with it, and the reply opens", async () => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate } = await import("./app-harness"), { useSnack } = await import("~/lib/snack");
    h.drafts.forgetDraft(h.key);
    useSnack.setState({ current: null });
    // the conversation's own read state, a sync or a landed send refetches it while the quote is measured: a new object
    let calls = 0;
    gate.load.mockImplementation(async (id: number) => {
      calls++;
      const detail = calls === 2 ? ({ ...h.detail, thread: { ...h.detail.thread } } as ThreadDetail) : h.detail;
      h.useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) }));
      return detail;
    });
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(calls).toBeGreaterThan(2);
      expect(opened(h)).toHaveLength(1);
      expect(useSnack.getState().current?.tone).not.toBe("error");
    } finally { await h.cleanup(); }
  });

  it.each(["sourceContext", "load"] as const)("a failure while the reply still matters says so (%s)", async (failing) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate } = await import("./app-harness"), { useSnack } = await import("~/lib/snack");
    h.drafts.forgetDraft(h.key);
    useSnack.setState({ current: null });
    if (failing === "sourceContext") gate.call.mockImplementation(async (method: string) => { if (method === "drafts.sourceContext") throw new Error("offline"); return {}; });
    else {
      h.useThreads.setState({ details: new Map() });
      gate.load.mockImplementation(async () => null);
    }
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(opened(h)).toHaveLength(0);
      expect(useSnack.getState().current).toMatchObject({ tone: "error", message: "Couldn't start the reply. Try again." });
    } finally { await h.cleanup(); }
  });

  it("a reply superseded by a newer choice stays silent", async () => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate } = await import("./app-harness"), { useSnack } = await import("~/lib/snack");
    h.drafts.forgetDraft(h.key);
    useSnack.setState({ current: null });
    gate.call.mockImplementation(async (method: string) => {
      if (method === "drafts.sourceContext") { h.app.setApp({ selectedId: null, readerOpen: false }); throw new Error("offline"); }
      return {};
    });
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(useSnack.getState().current?.tone).not.toBe("error");
    } finally { await h.cleanup(); }
  });

  it.each(["stale", "failed"] as const)("once the user moved focus elsewhere, a %s open neither retries into focus nor complains", async (outcome) => {
    const h = await setup("split", true);
    const { openCompose } = await import("~/lib/compose"), { gate } = await import("./app-harness"), { useSnack } = await import("~/lib/snack");
    h.drafts.forgetDraft(h.key);
    useSnack.setState({ current: null });
    let calls = 0;
    gate.load.mockImplementation(async (id: number) => {
      calls++;
      if (calls === 2) h.other.focus(); // the user went to another control while the reply was opening
      const detail = outcome === "stale" && calls === 2 ? ({ ...h.detail, thread: { ...h.detail.thread } } as ThreadDetail) : h.detail;
      h.useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) }));
      return detail;
    });
    if (outcome === "failed") gate.call.mockImplementation(async (method: string) => { if (method === "drafts.sourceContext") throw new Error("offline"); return {}; });
    try {
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(document.activeElement).toBe(h.other);
      expect(opened(h)).toHaveLength(0); // no retry opened it behind the user's back
      expect(useSnack.getState().current?.tone).not.toBe("error");
    } finally { await h.cleanup(); }
  });

  it("the menu counts a reply as opened inline or in the reader pane (a stored draft whose source moved)", async () => {
    const h = await setup("split", true);
    const { replyOpened } = await import("./thread-menu"), { openCompose } = await import("~/lib/compose");
    h.drafts.forgetDraft(h.key);
    try {
      expect(replyOpened(7, null)).toBe(false);
      // in the reader pane
      await act(async () => { h.app.setApp({ compose: { key: "pane", seq: 1 } }); });
      expect(replyOpened(7, null)).toBe(true);
      expect(replyOpened(7, h.app.getApp().compose)).toBe(false);
      await act(async () => { h.app.setApp({ compose: null }); });
      // inline in its conversation
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 4; i++) await h.flush();
      expect(opened(h)).toHaveLength(1);
      expect(replyOpened(7, null)).toBe(true);
    } finally { await h.cleanup(); }
  });
});

describe("same-mode open", () => {
  it.each(["saved", "unsaved", "saving", "open"] as const)("same-mode open preserves valid %s UI delta", async (scenario) => {
    const h = await setup("split", true), { openCompose } = await import("~/lib/compose");
    try {
      await act(async () => {
        h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: scenario === "open" ? "open" : "collapsed" });
        h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, ...(scenario === "unsaved" ? { id: null } : {}), ...(scenario === "saving" ? { status: "saving" as const } : {}) } } }));
      });
      const before = h.drafts.materialize(h.key)!; h.other.focus();
      await act(async () => { await openCompose("reply", 7); });
      const after = h.drafts.materialize(h.key)!;
      expect(after.uiState).toBe("open");
      expect(after.localRev).toBe(before.localRev + (scenario !== "open" && before.id !== null ? 1 : 0));
      if (scenario === "saving") expect(after.status).toBe("saving");
      for (let i = 0; i < 5; i++) await h.flush();
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { await h.cleanup(); }
  });
});

describe("conversion publication", () => {
  it.each(["replace", "ordinary", "unwritten replace", "unwritten ordinary"] as const)("conversion validates the draft after synchronous publication: %s", async (scenario) => {
    const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose");
    let triggered = false;
    try {
      if (scenario.startsWith("unwritten")) await act(async () => h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, bodyText: "", bodyHtml: "", localRev: 0, subjectEdited: false, attachments: [] } } })));
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.mode === "reply" && state.drafts[h.key]?.mode === "replyAll") {
          triggered = true;
          if (scenario.endsWith("replace")) h.drafts.editDraft(h.key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "newer body", bodyHtml: "<p>newer body</p>", toText: "newer@example.test" });
        }
      });
      try {
        await act(async () => { await openCompose("replyAll", 7); });
        expect(triggered).toBe(true);
        if (scenario.endsWith("replace")) {
          expect(h.drafts.materialize(h.key)).toMatchObject({ id: 81, generation: "stable", inReplyToMessageId: 4, bodyText: "newer body", bodyHtml: "<p>newer body</p>", toText: "newer@example.test" });
          expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
        } else { for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]')); }
      } finally { off(); }
    } finally { await h.cleanup(); }
  });

  it.each(["focus publication", "undo registration"] as const)("conversion stops stale feedback after a later edit during %s", async (phase) => {
    const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose"), { useSnack } = await import("~/lib/snack");
    let triggered = false;
    try {
      h.other.focus();
      const before = useSnack.getState();
      const replace = () => { triggered = true; h.drafts.editDraft(h.key, { inReplyToMessageId: 4, threadId: null, showSourceContext: false, bodyText: "later work" }); };
      const off = phase === "focus publication" ? h.app.useApp.subscribe((state) => { if (!triggered && state.draftFocus?.key === h.key) replace(); }) : useSnack.subscribe((state, previous) => { if (!triggered && state.undo !== previous.undo && state.undo) replace(); });
      try {
        await act(async () => { await openCompose("replyAll", 7); });
        expect(triggered).toBe(true);
        expect(h.drafts.materialize(h.key)).toMatchObject({ inReplyToMessageId: 4, bodyText: "later work" });
        expect(useSnack.getState().current).toBe(before.current);
        expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false);
        if (phase === "undo registration") expect(useSnack.getState().undo).toBeNull();
      } finally { off(); }
    } finally { await h.cleanup(); }
  });

  it.each(["target round trip", "unrelated draft"] as const)("conversion receipt distinguishes %s", async (scenario) => {
    const h = await setup("split", true), { openCompose, composeFocusPending } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields");
    let triggered = false;
    try {
      h.other.focus();
      const off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!triggered && previous.drafts[h.key]?.mode === "reply" && state.drafts[h.key]?.mode === "replyAll") {
          triggered = true;
          if (scenario === "target round trip") {
            h.drafts.editDraft(h.key, { inReplyToMessageId: 4 });
            h.drafts.editDraft(h.key, { inReplyToMessageId: 3 });
          } else h.drafts.createDraft(newFields(1));
        }
      });
      try {
        await act(async () => { await openCompose("replyAll", 7); });
        expect(triggered).toBe(true);
        if (scenario === "target round trip") { expect(h.app.getApp().draftFocus).toBeNull(); expect(composeFocusPending(7)).toBe(false); }
        else { for (let i = 0; i < 5; i++) await h.flush(); expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]')); }
      } finally { off(); }
    } finally { await h.cleanup(); }
  });
});

describe("no-writer conversion", () => {
  it.each(["absent attach dispose", "replacement", "reset", "coalesced edit", "writer appears", "target restoration", "ordinary"] as const)("no-writer conversion retains original source continuity: %s", async (scenario) => {
    const h = await setup("split", true), loading = deferred<ThreadDetail>(), entered = deferred<void>();
    const { openCompose, supersedeCompose } = await import("~/lib/compose"), { resetSnacks, useSnack } = await import("~/lib/snack");
    let source: ReturnType<typeof h.drafts.attachBody> | undefined, replacement: ReturnType<typeof h.drafts.attachBody> | undefined, opening: Promise<void> | undefined;
    try {
      resetSnacks();
      await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); });
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      if (scenario !== "absent attach dispose") source = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml }));
      gate.load.mockImplementation(async () => { entered.resolve(); return loading.promise; });
      await act(async () => { opening = openCompose("replyAll", 7); });
      await Promise.race([entered.promise, opening!.then(() => { throw new Error("Conversion finished before its gated load"); })]);
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toBe(before);
      if (scenario === "absent attach dispose") { replacement = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); replacement.dispose(); }
      if (scenario === "replacement") { replacement = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); replacement.dispose(); source = h.drafts.attachBody(h.key, () => ({ text: before.bodyText, html: before.bodyHtml })); }
      if (scenario === "reset") source!.reset();
      if (scenario === "coalesced edit") { await act(async () => { source!.changed(); source!.changed(); }); }
      if (scenario === "writer appears") h.drafts.retryDraft(h.key);
      if (scenario === "target restoration") await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...before, accountId: 99 } } })); h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: before } })); });
      await act(async () => { loading.resolve(h.detail); await opening; });
      const after = h.drafts.useDrafts.getState().drafts[h.key]!;
      if (scenario === "ordinary") expect(after.mode).toBe("replyAll");
      else { expect(after.mode).toBe("reply"); expect(h.app.getApp().draftFocus).toBeNull(); expect(useSnack.getState().undo).toBeNull(); }
      expect(after).toMatchObject({ key: h.key, id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    } finally { loading.resolve(h.detail); if (opening) await opening; supersedeCompose(); source?.dispose(); replacement?.dispose(); await h.cleanup(); }
  });

  it("an older no-writer completion cannot cancel a newer conversion", async () => {
    const h = await setup("split", true), first = deferred<ThreadDetail>(), second = deferred<ThreadDetail>();
    const { openCompose, supersedeCompose } = await import("~/lib/compose");
    let one: Promise<void> | undefined, two: Promise<void> | undefined, loads = 0;
    try {
      await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); });
      gate.load.mockImplementation(async () => (++loads === 1 ? first.promise : second.promise));
      await act(async () => { one = openCompose("replyAll", 7); });
      await act(async () => { two = openCompose("forward", 7); });
      expect(loads).toBe(2);
      await act(async () => { first.resolve(h.detail); await one; });
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.mode).toBe("reply");
      await act(async () => { second.resolve(h.detail); await two; });
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.mode).toBe("forward");
    } finally { first.resolve(h.detail); second.resolve(h.detail); await Promise.allSettled([one, two].filter((p): p is Promise<void> => Boolean(p))); supersedeCompose(); await h.cleanup(); }
  });

  it("converts an untouched no-writer reply without fabricating a saved draft", async () => {
    const h = await setup("split", true), loading = deferred<ThreadDetail>();
    const { openCompose, supersedeCompose } = await import("~/lib/compose"), { replyFields } = await import("~/lib/compose-fields");
    let key = "", opening: Promise<void> | undefined;
    try {
      await act(async () => {
        h.drafts.forgetDraft(h.key);
        key = h.drafts.createDraft(replyFields("reply", h.detail, h.app.getApp().accounts[0]!));
        h.app.setApp({ draftShown: { threadId: 7, key } });
      });
      expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ id: null, localRev: 0, status: "clean" });
      gate.load.mockReturnValue(loading.promise);
      await act(async () => { opening = openCompose("replyAll", 7); });
      await act(async () => { loading.resolve(h.detail); await opening; });
      expect(h.drafts.useDrafts.getState().drafts[key]).toMatchObject({ key, id: null, mode: "replyAll" });
    } finally { loading.resolve(h.detail); if (opening) await opening; supersedeCompose(); await h.cleanup(); }
  });
});

describe("saving-publication conversion", () => {
  it.each(["UI roundtrip", "ordinary"] as const)("saving-publication conversion does not rebase on %s", async (scenario) => {
    const h = await setup("split", true), loading = deferred<ThreadDetail>(), entered = deferred<void>(), ack = deferred<unknown>();
    const { openCompose, supersedeCompose } = await import("~/lib/compose"), { resetSnacks, useSnack } = await import("~/lib/snack");
    let opening: Promise<void> | undefined, saving: Promise<void> | undefined, off = () => {}, calls = 0;
    try {
      resetSnacks();
      await act(async () => { h.drafts.useDrafts.setState((state) => ({ drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, threadId: 7, showSourceContext: false, inReplyToMessageId: 3 } } })); h.drafts.editDraft(h.key, { bodyText: "exact work", bodyHtml: "<p>exact work</p>" }); });
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      h.drafts.setDraftTransport(async (_method, params) => { calls++; await ack.promise; return { ...params as object, id: before.id, generation: before.generation, revision: before.revision + 1, updatedAt: 0 }; });
      gate.load.mockImplementation(async () => { entered.resolve(); return loading.promise; });
      off = h.drafts.useDrafts.subscribe((state, previous) => {
        if (scenario === "UI roundtrip" && !opening && state.drafts[h.key]?.status === "saving" && previous.drafts[h.key]?.status !== "saving") opening = openCompose("replyAll", 7);
      });
      await act(async () => { saving = h.drafts.flushDraft(h.key); if (scenario === "ordinary") opening = openCompose("replyAll", 7); });
      const reachedLoad = await Promise.race([entered.promise.then(() => true), opening!.then(() => false), saving!.then(() => { throw new Error("Save completed before its gate"); })]);
      expect(opening).toBeDefined(); expect(calls).toBe(1);
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ key: h.key, id: before.id, generation: before.generation, revision: before.revision, mode: "reply", bodyText: "exact work" });
      if (scenario === "UI roundtrip") await act(async () => { h.drafts.setDraftUi(h.key, "collapsed"); h.drafts.setDraftUi(h.key, "open"); });
      await act(async () => { if (reachedLoad) loading.resolve(h.detail); await opening; });
      const after = h.drafts.useDrafts.getState().drafts[h.key]!;
      if (scenario === "UI roundtrip") { expect(after.mode).toBe("reply"); expect(h.app.getApp().draftFocus).toBeNull(); expect(useSnack.getState().undo).toBeNull(); }
      else expect(after.mode).toBe("replyAll");
      expect(after).toMatchObject({ key: h.key, bodyText: "exact work", bodyHtml: "<p>exact work</p>" });
    } finally { off(); loading.resolve(h.detail); ack.resolve(null); await Promise.allSettled([opening, saving].filter((p): p is Promise<void> => Boolean(p))); supersedeCompose(); h.drafts.setDraftTransport(async () => null); await h.cleanup(); }
  });
});

describe("Forward's notification frontier", () => {
  type DraftState = ReturnType<typeof import("../lib/drafts")["useDrafts"]["getState"]>;
  const schedules = ["normal child", "completed raw then child", "raw restore", "raw still delivering", "no-op child", "held child"] as const;
  const names = {
    "normal child": "frontier: late Forward after normal child close wins",
    "completed raw then child": "frontier: completed raw edge then certified child permits first Forward",
    "raw restore": "frontier: raw restore without a new child refuses first Forward",
    "raw still delivering": "frontier: an unknown traversal delivered after admission remains terminal",
    "no-op child": "frontier: a no-op child cannot rearm a compromised ancestor",
    "held child": "frontier: a held child cannot rearm a compromised ancestor",
  };

  for (const schedule of schedules) it(names[schedule], async () => {
    const h = await setup("split", true), waiting = deferred<ThreadDetail>();
    const { openCompose, supersedeCompose } = await import("../lib/compose");
    const { resetForwardFiles } = await import("../lib/forward-files");
    let offFirst = () => {}, offLater = () => {}, offChild = () => {};
    let outer: DraftState | undefined, outerBefore: DraftState | undefined, raw: DraftState | undefined;
    let afterFirst: DraftState | undefined, afterChild: DraftState | undefined;
    let entered = false, requested = false, childEntered = false, childPublications = 0;
    let operation: Promise<void> | undefined;
    const phases: string[] = [];
    try {
      await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      expect(before).toMatchObject({ mode: "reply", uiState: "collapsed", generation: "stable" });
      h.other.focus(); gate.load.mockClear(); gate.load.mockReturnValue(waiting.promise);
      offChild = h.drafts.useDrafts.subscribe((state, previous) => {
        if (entered && state.drafts[h.key]?.uiState === "collapsed" && previous.drafts[h.key]?.uiState === "open") childPublications++;
      });
      const child = () => {
        childEntered = true;
        h.drafts.setDraftUi(h.key, schedule === "no-op child" ? "open" : "collapsed");
        afterChild = h.drafts.useDrafts.getState();
        phases.push("child-returned");
      };
      offFirst = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!entered && state.drafts[h.key]?.uiState === "open" && previous.drafts[h.key]?.uiState === "collapsed") {
          entered = true; outer = state; outerBefore = previous;
          if (schedule === "raw still delivering") {
            raw = { ...state, drafts: { ...state.drafts } };
            h.drafts.useDrafts.setState(raw, true); phases.push("raw-returned");
          } else {
            if (schedule !== "normal child") {
              h.drafts.useDrafts.setState({ ...state, drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, subject: "temporary raw edge" } } }, true);
              h.drafts.useDrafts.setState(state, true); phases.push("raw-returned");
            }
            if (schedule === "held child") {
              const release = h.drafts.acquireDraftHold();
              try { expect(release).not.toBeNull(); child(); } finally { release?.(); }
            } else if (schedule !== "raw restore") child();
          }
          afterFirst = h.drafts.useDrafts.getState();
        } else if (schedule === "raw still delivering" && state === raw && !childEntered) child();
      });
      offLater = h.drafts.useDrafts.subscribe((state, previous) => {
        // Zustand supplies live current state with this emission's captured previous state.
        const expected = schedule === "raw still delivering" ? afterChild : afterFirst;
        const delivery = expected !== undefined && state === expected && previous === (schedule === "raw still delivering" ? outer : outerBefore);
        if (!delivery || requested) return;
        requested = true; phases.push("requested"); operation = openCompose("forward", 7);
      });
      await act(async () => h.drafts.setDraftUi(h.key, "open"));
      expect(entered).toBe(true); expect(requested).toBe(true); expect(operation).toBeDefined();
      expect(childPublications).toBe(schedule === "normal child" || schedule === "completed raw then child" || schedule === "raw still delivering" ? 1 : 0);
      if (schedule === "normal child" || schedule === "completed raw then child") {
        expect(afterFirst).toBe(afterChild); expect(afterChild?.drafts[h.key]?.uiState).toBe("collapsed");
      }
      if (schedule === "completed raw then child") {
        expect(phases.indexOf("raw-returned")).toBeLessThan(phases.indexOf("child-returned"));
        expect(phases.indexOf("child-returned")).toBeLessThan(phases.indexOf("requested"));
      }
      if (schedule === "raw still delivering") expect(phases.indexOf("requested")).toBeLessThan(phases.indexOf("raw-returned"));
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
      await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; });
      for (let i = 0; i < 5; i++) await h.flush();
      const current = h.drafts.useDrafts.getState().drafts[h.key]!;
      const positive = schedule === "normal child" || schedule === "completed raw then child";
      expect(current.mode).toBe(positive ? "forward" : "reply");
      expect(current).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
      if (positive) {
        const to = h.host.querySelector('[data-testid="compose-to"]'); expect(to).not.toBeNull(); expect(document.activeElement).toBe(to);
      } else expect(h.app.getApp().draftFocus).toBeNull();
    } finally {
      offFirst(); offLater(); offChild(); waiting.resolve(h.detail);
      await Promise.allSettled(operation ? [operation] : []); supersedeCompose(); resetForwardFiles(); await h.cleanup();
    }
  });

  for (const later of ["hold", "source change"] as const) it(`frontier: later ${later} retires a consumed ancestor receipt`, async () => {
    const h = await setup("split", true), { controllerFor } = await import("./composer/controller");
    let entered = false, token: DraftAckRead | undefined, offFirst = () => {}, offLater = () => {}; const hold: { release: (() => void) | null } = { release: null };
    let child: DraftState | undefined, beforeOuter: DraftState | undefined;
    try {
      const controller = controllerFor(h.key); expect(controller).not.toBeNull();
      offFirst = h.drafts.useDrafts.subscribe((state, previous) => {
        if (entered || state.drafts[h.key]?.uiState !== "collapsed" || previous.drafts[h.key]?.uiState !== "open") return;
        entered = true; beforeOuter = previous; h.drafts.setDraftUi(h.key, "open"); child = h.drafts.useDrafts.getState();
      });
      offLater = h.drafts.useDrafts.subscribe((state, previous) => {
        if (!child || state !== child || previous !== beforeOuter || token) return;
        const admission = h.drafts.beginDraftAckRead(h.drafts.useDrafts.getState().drafts[h.key]!);
        if (admission.kind !== "refused") token = admission.kind === "proof" ? admission.proof : admission.continuity;
      });
      await act(async () => h.drafts.setDraftUi(h.key, "collapsed"));
      expect(entered).toBe(true); expect(token).toBeDefined();
      expect(controllerFor(h.key)).toBe(controller);
      expect(h.drafts.readDraftAck(token!)).toBe(h.drafts.useDrafts.getState().drafts[h.key]);
      if (later === "hold") {
        await act(async () => { hold.release = h.drafts.acquireDraftHold(); expect(hold.release).not.toBeNull(); hold.release?.(); hold.release = null; });
      } else await act(async () => controller!.run("quote"));
      expect(h.drafts.readDraftAck(token!)).toBeUndefined();
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toContain("exact authored work");
      if (later === "source change") expect(controller!.dom.querySelector("blockquote")).not.toBeNull();
    } finally { offFirst(); offLater(); hold.release?.(); if (token) h.drafts.endDraftAckRead(token); await h.cleanup(); }
  });
});
