import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { acquireDraftHold, attachBody, beginDraftAckRead, createDraft, draftChangeVersion, draftForSend, editDraft, endDraftAckRead, flushDraft, forgetDraft, loadDrafts, markDraftMissing, materialize, resumeDraft, setDraftTransport, setDraftUi, useDrafts, type LocalDraft } from "./drafts";

const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
const body = { bodyText: "retained authored body", bodyHtml: "<p><b>retained authored body</b></p>" };
const scenarios = ["throw then flush", "ordinary deadline", "source recovers during publication", "no-op", "held", "recovery", "unsaved", "nested forget", "nested successor", "nested stopping"] as const;

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const scenario of scenarios) {
  it(`${adapter}: UI publication retains Writer work through ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-ui-writer-")), name = crypto.randomUUID();
    const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: adapter === "IDB instant", platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
    let store = await open(), stopped = false;
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "ui-publication-writer", origin: "renderer" }); const client = new RpcClient(c);
    const keys = new Set<string>(); let key: string | undefined, source: ReturnType<typeof attachBody> | undefined, releaseHold: (() => void) | null = null;
    let off = () => {}, offSaved = () => {}, observed = 0, reservation: Promise<LocalDraft | undefined> | undefined;
    let acknowledge!: () => void; const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    const calls: Array<ReturnType<typeof contract["drafts.save"]["params"]["parse"]>> = [];
    const pending = new Set<Promise<unknown>>();
    const failures: Array<{ request: number; error: unknown }> = [];
    const responses: Array<{ request: number; result: Awaited<ReturnType<typeof client.call<"drafts.save">>> }> = [];
    let drainedReservations: PromiseSettledResult<unknown>[] = [], drainedRequests: PromiseSettledResult<unknown>[] = [];
    setDraftTransport((method, params) => {
      if (method !== "drafts.save") throw new Error("Unexpected writer method");
      const input = contract["drafts.save"].params.parse(params); calls.push(input);
      const index = calls.length, request = client.call("drafts.save", input); pending.add(request);
      void request.then((result) => { responses.push({ request: index, result }); pending.delete(request); }, (error: unknown) => { failures.push({ request: index, error }); pending.delete(request); });
      return request;
    });
    try {
      const [accountId] = await withAccounts(store);
      const saved = (await client.call("drafts.save", { accountId: accountId!, mode: "new", to: [{ name: "", email: "authored@example.test" }], subject: "authored subject", subjectEdited: true, ...body, uiState: "collapsed", showSourceContext: false }))!;
      expect(saved).toMatchObject({ revision: 1, ...body, uiState: "collapsed" }); expect(saved.generation).toBeTruthy();
      await loadDrafts(() => client.call("drafts.list", {}));
      key = Object.values(useDrafts.getState().drafts).find((d) => d.id === saved.id && d.generation === saved.generation)!.key; keys.add(key);
      let before = useDrafts.getState().drafts[key]!;
      expect(before).toMatchObject({ id: saved.id, generation: saved.generation, status: "saved", localRev: 0, savedRev: 0, ...body });
      const admission = beginDraftAckRead(before);
      expect(admission.kind).toBe("no-writer");
      if (admission.kind !== "refused") endDraftAckRead(admission.kind === "proof" ? admission.proof : admission.continuity);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      offSaved = useDrafts.subscribe((state) => {
        const d = key ? state.drafts[key] : undefined;
        if (d && d.id === saved.id && d.generation === saved.generation && d.revision > saved.revision && d.status === "saved" && d.savedRev === d.localRev) acknowledge();
      });
      if (scenario === "source recovers during publication") {
        let failing = true;
        source = attachBody(key, () => { if (failing) throw new Error("source unread"); return { text: body.bodyText, html: body.bodyHtml }; });
        source.changed(); expect(() => materialize(key!)).toThrow("source unread");
        before = useDrafts.getState().drafts[key]!;
        off = useDrafts.subscribe((state, previous) => {
          if (state.drafts[key!]?.uiState !== "open" || previous.drafts[key!]?.uiState !== "collapsed") return;
          observed++; off(); failing = false; expect(materialize(key!)).toMatchObject(body);
        });
      } else if (["throw then flush", "nested forget", "nested successor", "nested stopping"].includes(scenario)) {
        off = useDrafts.subscribe((state, previous) => {
          const d = state.drafts[key!];
          if (!d || d.uiState !== "open" || previous.drafts[key!]?.uiState !== "collapsed") return;
          observed++; off();
          expect(d).toMatchObject({ key, id: saved.id, generation: saved.generation, ...body, uiState: "open", localRev: before.localRev + 1 });
          if (scenario === "nested forget") forgetDraft(key!);
          if (scenario === "nested successor") expect(editDraft(key!, { subject: "newer subject", subjectEdited: true, bodyText: "newer body", bodyHtml: "<p>newer body</p>" })).toBe(true);
          if (scenario === "nested stopping") reservation = draftForSend(key!);
          if (scenario === "throw then flush" || scenario === "nested successor") throw new Error("observer failed after published UI");
        });
      }
      if (scenario === "unsaved") {
        key = createDraft({ ...newFields(accountId!), ...body, uiState: "collapsed" }); keys.add(key); before = useDrafts.getState().drafts[key]!;
      }
      if (scenario === "recovery") { markDraftMissing(key); before = useDrafts.getState().drafts[key]!; }
      const version = draftChangeVersion();
      if (scenario === "held") { releaseHold = acquireDraftHold(); expect(releaseHold).not.toBeNull(); }
      if (scenario === "throw then flush" || scenario === "nested successor") expect(() => setDraftUi(key!, "open")).toThrow("observer failed after published UI");
      else setDraftUi(key, scenario === "no-op" ? "collapsed" : "open");
      if (["no-op", "held"].includes(scenario)) {
        expect(useDrafts.getState().drafts[key]).toBe(before); expect(draftChangeVersion()).toBe(version);
        releaseHold?.(); releaseHold = null;
        await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(0);
        const after = beginDraftAckRead(before); expect(after.kind).toBe("no-writer");
        if (after.kind !== "refused") endDraftAckRead(after.kind === "proof" ? after.proof : after.continuity);
      } else if (scenario === "recovery") {
        expect(useDrafts.getState().drafts[key]).toMatchObject({ key, uiState: "open", recovery: { state: "missing" }, ...body });
        await vi.advanceTimersByTimeAsync(1000); await flushDraft(key); expect(calls).toHaveLength(0);
        expect(beginDraftAckRead(useDrafts.getState().drafts[key]!).kind).toBe("refused");
      } else if (scenario === "unsaved") {
        expect(useDrafts.getState().drafts[key]).toMatchObject({ id: null, localRev: 0, savedRev: 0, uiState: "open", ...body });
        await vi.advanceTimersByTimeAsync(1000); await flushDraft(key); expect(calls).toHaveLength(0);
        const after = beginDraftAckRead(useDrafts.getState().drafts[key]!); expect(after.kind).toBe("no-writer");
        if (after.kind !== "refused") endDraftAckRead(after.kind === "proof" ? after.proof : after.continuity);
      } else if (scenario === "nested forget") {
        expect(observed).toBe(1); expect(useDrafts.getState().drafts[key]).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1000); await flushDraft(key); expect(calls).toHaveLength(0);
      } else {
        if (scenario !== "ordinary deadline") expect(observed).toBe(1);
        const current = useDrafts.getState().drafts[key]!;
        expect(current).toMatchObject({ key, id: saved.id, generation: saved.generation, uiState: "open" });
        expect(current.localRev).toBe(before.localRev + (scenario === "nested successor" ? 2 : 1));
        if (scenario === "ordinary deadline" || scenario === "source recovers during publication") {
          await vi.advanceTimersByTimeAsync(799); expect(calls).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(1); expect(calls).toHaveLength(1); await acknowledged;
        } else if (scenario === "nested stopping") {
          expect(await reservation).toMatchObject({ key, uiState: "open", ...body });
          expect(await draftForSend(key)).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(0);
          resumeDraft(key); await vi.advanceTimersByTimeAsync(800); expect(calls).toHaveLength(1); await acknowledged;
        } else await flushDraft(key);
        const expected = scenario === "nested successor" ? { bodyText: "newer body", bodyHtml: "<p>newer body</p>", subject: "newer subject" } : { ...body, subject: "authored subject" };
        expect.soft(calls).toHaveLength(1);
        expect.soft(calls[0]).toMatchObject({ id: saved.id, generation: saved.generation, baseRevision: 1, uiState: "open", ...expected });
        const done = useDrafts.getState().drafts[key]!;
        expect.soft(done).toMatchObject({ key, id: saved.id, generation: saved.generation, status: "saved", uiState: "open", ...expected });
        expect.soft(done.savedRev).toBe(done.localRev);
        c.close(); await backend.stop(); stopped = true; store = await open();
        const row = (await store.drafts.list())[0]!;
        expect(row).toMatchObject({ id: saved.id, generation: saved.generation, revision: 2, ui_state: "open", body_text: expected.bodyText, body_html: expected.bodyHtml, subject: expected.subject });
      }
    } finally {
      off(); offSaved(); acknowledge(); releaseHold?.();
      for (const k of keys) forgetDraft(k); source?.dispose(); vi.useRealTimers();
      try {
        drainedReservations = await Promise.allSettled(reservation ? [reservation] : []); drainedRequests = await Promise.allSettled([...pending]);
      } finally {
        setDraftTransport(async () => { throw new Error("No active UI writer fixture"); }); c.close();
        try {
          try { if (!stopped) await backend.stop(); else await store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
        } finally {
          expect.soft(failures).toEqual([]);
          expect.soft([...drainedReservations, ...drainedRequests].filter((entry) => entry.status === "rejected")).toEqual([]);
          expect.soft(responses).toHaveLength(calls.length);
          expect.soft(responses.map((entry) => entry.result === null)).not.toContain(true);
        }
      }
    }
  });
}
