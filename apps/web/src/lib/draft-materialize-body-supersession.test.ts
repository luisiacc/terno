import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { attachBody, beginDraftAckRead, beginForwardEmptyOwnerRead, readDraftAck, endDraftAckRead, createDraft, editDraft, flushDraft, forgetDraft, materialize, setDraftTransport, useDrafts } from "./drafts";

const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
const latest = { bodyText: "accepted newer body", bodyHtml: "<p><b>accepted newer body</b></p>" };
const earlier = { text: "older editor body", html: "<p>older editor body</p>" };

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) {
  for (const scenario of ["materialize", "flush", "autosave", "scheduled only", "ordinary", "reset", "read throw", "coalesced", "replacement"] as const) {
    it(`${adapter}: body supersession during ${scenario} preserves current work through reopen`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-body-supersession-")), name = crypto.randomUUID();
      const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
      let store = await open(), stopped = false;
      const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
      const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "body-supersession", origin: "renderer" }); const client = new RpcClient(c);
      let key: string | undefined, source: ReturnType<typeof attachBody> | undefined, replacement: ReturnType<typeof attachBody> | undefined;
      let stopAck = () => {};
      let acknowledge!: () => void; const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
      let off = () => {}, armed = true, accepted = false, reads = 0, failRead = scenario === "read throw", text = earlier.text;
      const calls: Array<{ bodyText: string; bodyHtml?: string }> = [];
      setDraftTransport(async (method, params) => {
        if (method !== "drafts.save") throw new Error("Unexpected writer method");
        calls.push(params as { bodyText: string; bodyHtml?: string });
        return client.call("drafts.save", params as Parameters<typeof client.call<"drafts.save">>[1]);
      });
      try {
        const [accountId] = await withAccounts(store);
        key = createDraft({ ...newFields(accountId!), bodyText: "saved baseline", bodyHtml: "<p>saved baseline</p>" });
        editDraft(key, {}); await flushDraft(key);
        const original = useDrafts.getState().drafts[key]!;
        expect(original).toMatchObject({ status: "saved", revision: 1 }); expect(original.generation).toBeTruthy();
        stopAck = useDrafts.subscribe((state) => { if (key && state.drafts[key]?.status === "saved" && state.drafts[key]!.revision > original.revision) acknowledge(); });
        calls.length = 0; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        source = attachBody(key, () => {
          reads++;
          if (failRead) throw new Error("owned read failed");
          const captured = text;
          if (scenario === "coalesced" && armed) { armed = false; text = latest.bodyText; source!.changed(); source!.changed(); }
          return { text: captured, html: captured === latest.bodyText ? latest.bodyHtml : earlier.html };
        });
        source.changed();
        const publication = ["materialize", "flush", "autosave", "scheduled only", "reset", "replacement"].includes(scenario);
        if (publication) off = useDrafts.subscribe((state, before) => {
          if (!armed || state.drafts[key!]?.bodyText !== earlier.text || before.drafts[key!]?.bodyText === earlier.text) return;
          armed = false; off();
          if (scenario === "replacement") { replacement = attachBody(key!, () => ({ text: latest.bodyText, html: latest.bodyHtml })); replacement.changed(); }
          else {
            accepted = editDraft(key!, { ...latest, subject: "accepted subject", subjectEdited: true });
            if (scenario === "reset") source!.reset();
          }
        });
        if (scenario === "autosave" || scenario === "scheduled only") await vi.advanceTimersByTimeAsync(800);
        else if (scenario === "flush") await flushDraft(key);
        else if (scenario === "ordinary") expect(materialize(key)).toMatchObject({ bodyText: earlier.text });
        else if (scenario === "read throw") {
          expect(() => materialize(key!)).toThrow("owned read failed");
          const failedReads = reads; await vi.advanceTimersByTimeAsync(10_000); expect(reads).toBe(failedReads); expect(calls).toHaveLength(0);
          failRead = false; text = latest.bodyText;
        } else expect(() => materialize(key!)).toThrow("Your draft changed while it was being read. Your changes are still here. Try again.");
        const current = useDrafts.getState().drafts[key]!;
        if (["materialize", "flush", "autosave", "scheduled only", "reset"].includes(scenario)) {
          expect(accepted).toBe(true);
          expect(current).toMatchObject({ ...latest, key, id: original.id, generation: original.generation, bodyVersion: original.bodyVersion + 1, subject: "accepted subject" });
          expect(current.localRev).toBeGreaterThan(original.localRev);
        }
        const expected = scenario === "ordinary" ? { bodyText: earlier.text, bodyHtml: earlier.html } : latest;
        // Soft assertions retain the reread and durable-persistence boundaries independently.
        if (scenario !== "scheduled only") expect.soft(materialize(key)).toMatchObject(expected);
        if (scenario === "scheduled only") {
          expect(calls).toHaveLength(0); await vi.advanceTimersByTimeAsync(799); expect(calls).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(1); expect.soft(calls).toHaveLength(1); expect.soft(calls[0]).toMatchObject(latest);
          if (calls.length === 1) await acknowledged;
        }
        if (scenario === "autosave") { await vi.advanceTimersByTimeAsync(800); expect.soft(calls.some((p) => p.bodyText === latest.bodyText)).toBe(true); }
        if (scenario !== "scheduled only") await flushDraft(key);
        expect.soft(useDrafts.getState().drafts[key]).toMatchObject({ ...expected, id: original.id, generation: original.generation, status: "saved" });
        c.close(); await backend.stop(); stopped = true;
        store = await open();
        expect.soft((await store.drafts.list())[0]).toMatchObject({ id: original.id, generation: original.generation, body_text: expected.bodyText, body_html: expected.bodyHtml });
      } finally {
        off(); stopAck(); acknowledge(); if (key) forgetDraft(key); source?.dispose(); replacement?.dispose(); vi.useRealTimers();
        setDraftTransport(async () => { throw new Error("No active fixture transport"); }); c.close();
        try { if (!stopped) await backend.stop(); else await store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    });
  }
}

for (const scenario of ["reset only", "nested read", "patch then change", "patch revert", "coalesced revert", "throw after reset", "throw after change", "successor proof"] as const) {
  it(`stale materialization cleanup preserves ${scenario} ownership`, () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const key = createDraft({ ...newFields(1), bodyText: "baseline", bodyHtml: "<p>baseline</p>" });
    let source: ReturnType<typeof attachBody>, armed = true, text = "editor", reads = 0;
    let successor: ReturnType<typeof beginDraftAckRead> | undefined;
    const admission = () => {
      const value = beginDraftAckRead(useDrafts.getState().drafts[key]!);
      expect(value.kind).not.toBe("refused"); return value;
    };
    source = attachBody(key, () => {
      reads++;
      if (armed) {
        armed = false;
        if (scenario === "reset only" || scenario === "throw after reset" || scenario === "successor proof") source.reset();
        if (scenario === "nested read") materialize(key);
        if (scenario === "throw after change" || scenario === "coalesced revert") { text = "new editor"; source.changed(); if (scenario === "coalesced revert") { text = "editor"; source.changed(); } }
        if (scenario === "successor proof") successor = admission();
        if (scenario.startsWith("throw")) throw new Error("reader threw after newer lifecycle");
      }
      return { text, html: `<p>${text}</p>` };
    });
    let off = () => {}, old: ReturnType<typeof beginForwardEmptyOwnerRead> = undefined;
    try {
      if (scenario === "successor proof") {
        const first = admission(); expect(first.kind).toBe("no-writer");
        // changed() creates a Writer, so enter the real Writer phase before the read.
        editDraft(key, { subject: "authored" }); const owned = admission();
        if (owned.kind === "proof") old = beginForwardEmptyOwnerRead(owned.proof);
        expect(old).toBeDefined();
      }
      if (scenario === "patch then change" || scenario === "patch revert") off = useDrafts.subscribe((state, previous) => {
        if (state.drafts[key]?.bodyText !== "editor" || previous.drafts[key]?.bodyText === "editor") return;
        off(); expect(editDraft(key, latest)).toBe(true);
        if (scenario === "patch revert") expect(editDraft(key, { bodyText: "editor", bodyHtml: "<p>editor</p>" })).toBe(true);
        else { text = "later editor"; source.changed(); }
      });
      source.changed();
      expect(() => materialize(key)).toThrow(scenario.startsWith("throw") ? "reader threw after newer lifecycle" : "Your draft changed while it was being read. Your changes are still here. Try again.");
      const before = reads;
      const result = materialize(key)!;
      if (["reset only", "throw after reset", "nested read", "patch revert", "successor proof"].includes(scenario)) expect(reads).toBe(before);
      expect(result.bodyText).toBe(scenario === "reset only" || scenario === "throw after reset" || scenario === "successor proof" ? "baseline" : scenario === "patch then change" ? "later editor" : scenario === "throw after change" ? "new editor" : "editor");
      if (old) expect(readDraftAck(old)).toBeUndefined();
      if (successor && successor.kind !== "refused") { const proof = successor.kind === "proof" ? successor.proof : successor.continuity; expect(readDraftAck(proof)).toBe(result); endDraftAckRead(proof); }
    } finally { off(); forgetDraft(key); source.dispose(); vi.useRealTimers(); }
  });
}
