// @vitest-environment jsdom
// A UI-only publication while a draft's acknowledgement is being read.
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, contract, createMemoryTransportPair } from "@terno/core/rpc";
import { SqlMailStore, nodePlatform, openDatabase } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { ProviderRegistry } from "@terno/mail";
import { withAccounts } from "@terno/store/conformance";
import { describe, expect, it, vi } from "vitest";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { acquireDraftHold, attachBody, beginComposeBodyAckRead, beginDraftAckRead, beginForwardEmptyOwnerRead, createDraft, draftChangeVersion, draftForSend, editDraft, endDraftAckRead, flushDraft, forgetDraft, loadDrafts, markDraftMissing, materialize, readDraftAck, resumeDraft, setDraftTransport, setDraftUi, type DraftAckRead, type LocalDraft, useDrafts } from "./drafts";


describe("receipts", () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
  const body = { bodyText: "retained authored body", bodyHtml: "<p>retained authored body</p>" };
  type Flavor = "existing Writer" | "hydrated saved" | "unsaved";
  type State = ReturnType<typeof useDrafts.getState>;

  async function fixture(flavor: Flavor, run: (f: {
    key: string;
    current(): LocalDraft;
    admit(): DraftAckRead | undefined;
    subscribe(listener: (state: State, previous: State) => void): void;
    source(): ReturnType<typeof attachBody>;
    hold(): void;
    requests: unknown[];
  }) => Promise<void> | void): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "terno-ui-receipt-"));
    const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "ui-publication-receipt", origin: "renderer" });
    const client = new RpcClient(c), pending = new Set<Promise<unknown>>();
    const failures: unknown[] = [], requests: unknown[] = [], responses: unknown[] = [];
    const tokens: DraftAckRead[] = [], subscriptions: Array<() => void> = [], sources: Array<ReturnType<typeof attachBody>> = [];
    let key: string | undefined;
    setDraftTransport((method, params) => {
      if (method !== "drafts.save") throw new Error("Unexpected receipt transport method");
      const input = contract["drafts.save"].params.parse(params); requests.push(input);
      const request = client.call("drafts.save", input); pending.add(request);
      void request.then((result) => { responses.push(result); pending.delete(request); }, (error: unknown) => { failures.push(error); pending.delete(request); });
      return request;
    });
    try {
      const [accountId] = await withAccounts(store);
      const saved = (await client.call("drafts.save", { accountId: accountId!, mode: "new", to: [{ name: "", email: "authored@example.test" }], subject: "authored subject", subjectEdited: true, ...body, uiState: "collapsed", showSourceContext: false }))!;
      await loadDrafts(() => client.call("drafts.list", {}));
      key = Object.values(useDrafts.getState().drafts).find((d) => d.id === saved.id && d.generation === saved.generation)!.key;
      if (flavor === "unsaved") { forgetDraft(key); key = createDraft({ ...newFields(accountId!), ...body, uiState: "collapsed" }); }
      if (flavor === "existing Writer") { expect(editDraft(key, { subject: "authored subject", subjectEdited: true })).toBe(true); await flushDraft(key); }
      const target = key;
      expect(useDrafts.getState().drafts[target]).toMatchObject({ key: target, uiState: "collapsed", ...body });
      await run({
        key: target,
        current: () => useDrafts.getState().drafts[target]!,
        admit: () => {
          const admission = beginDraftAckRead(useDrafts.getState().drafts[target]!);
          const token = admission.kind === "proof" ? admission.proof : admission.kind === "no-writer" ? admission.continuity : undefined;
          if (token) tokens.push(token);
          return token;
        },
        subscribe: (listener) => { subscriptions.push(useDrafts.subscribe(listener)); },
        source: () => { const source = attachBody(target, () => ({ text: body.bodyText, html: body.bodyHtml })); sources.push(source); return source; },
        hold: () => { const release = acquireDraftHold(); try { expect(release).not.toBeNull(); } finally { release?.(); } },
        requests,
      });
    } finally {
      for (const off of subscriptions) off();
      for (const token of tokens) endDraftAckRead(token);
      if (key) forgetDraft(key);
      for (const source of sources) source.dispose();
      try { await Promise.allSettled(pending); }
      finally {
        setDraftTransport(async () => { throw new Error("No active receipt fixture"); }); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
        expect.soft(failures).toEqual([]); expect.soft(responses).toHaveLength(requests.length); expect.soft(responses).not.toContain(null);
      }
    }
  }

  for (const flavor of ["existing Writer", "hydrated saved", "unsaved"] as const) {
    it(`${flavor}: first UI admission survives only its inherited edge`, async () => {
      await fixture(flavor, (f) => {
        let token: DraftAckRead | undefined, delivered = 0;
        f.subscribe((state, previous) => {
          if (token || state.drafts[f.key]?.uiState !== "open" || previous.drafts[f.key]?.uiState !== "collapsed") return;
          delivered++; token = f.admit(); expect(token).toBeDefined();
          expect(readDraftAck(token!)).toBe(state.drafts[f.key]);
        });
        setDraftUi(f.key, "open");
        expect(delivered).toBe(1); expect(readDraftAck(token!)).toBe(f.current());
        expect(f.current()).toMatchObject({ key: f.key, uiState: "open", ...body });
      });
    });
  }

  for (const throwing of [false, true]) {
    it(`original publication stamp refuses admission after earlier restore${throwing ? " and later throw" : ""}`, async () => {
      await fixture("existing Writer", (f) => {
        let original: State | undefined, previousOriginal: State | undefined, restored = false, attempted = 0;
        f.subscribe((state, previous) => {
          if (original || state.drafts[f.key]?.uiState !== "open") return;
          original = state; previousOriginal = previous;
          useDrafts.setState({ ...state, drafts: { ...state.drafts, [f.key]: { ...state.drafts[f.key]!, subject: "temporary" } } }, true);
          useDrafts.setState(state, true); restored = true;
        });
        f.subscribe((state, previous) => {
          if (!restored || state !== original || previous !== previousOriginal) return;
          attempted++; expect(f.admit()).toBeUndefined();
          if (throwing) throw new Error("later observer");
        });
        if (throwing) expect(() => setDraftUi(f.key, "open")).toThrow("later observer"); else setDraftUi(f.key, "open");
        expect(attempted).toBe(1); expect(useDrafts.getState()).toBe(original);
      });
    });
  }

  for (const phase of ["before delivery", "after delivery"] as const) {
    it(`exception ${phase} retires the exact linked admission`, async () => {
      await fixture("existing Writer", (f) => {
        let token: DraftAckRead | undefined;
        f.subscribe((state, previous) => {
          if (token || state.drafts[f.key]?.uiState !== "open" || previous.drafts[f.key]?.uiState !== "collapsed") return;
          token = f.admit(); expect(token).toBeDefined();
          if (phase === "before delivery") throw new Error("incomplete UI delivery");
          f.subscribe(() => { throw new Error("incomplete UI delivery"); });
        });
        expect(() => setDraftUi(f.key, "open")).toThrow("incomplete UI delivery");
        expect(readDraftAck(token!)).toBeUndefined(); expect(f.current()).toMatchObject({ uiState: "open", ...body });
      });
    });
  }

  for (const mutation of ["unrelated notification", "hold roundtrip", "coalesced body", "source replacement", "source reset"] as const) {
    it(`pending receipt rejects ${mutation} before inherited delivery`, async () => {
      await fixture("existing Writer", (f) => {
        const source = mutation === "coalesced body" || mutation === "source replacement" || mutation === "source reset" ? f.source() : undefined;
        let token: DraftAckRead | undefined, entered = false;
        f.subscribe((state, previous) => {
          if (entered || state.drafts[f.key]?.uiState !== "open" || previous.drafts[f.key]?.uiState !== "collapsed") return;
          entered = true; token = f.admit(); expect(token).toBeDefined();
          if (mutation === "unrelated notification") useDrafts.setState({ drafts: { ...state.drafts } });
          if (mutation === "hold roundtrip") f.hold();
          if (mutation === "coalesced body") { source!.changed(); source!.changed(); }
          if (mutation === "source replacement") f.source();
          if (mutation === "source reset") source!.reset();
          expect(readDraftAck(token!)).toBeUndefined();
        });
        setDraftUi(f.key, "open"); expect(entered).toBe(true); expect(readDraftAck(token!)).toBeUndefined();
      });
    });
  }

  it("nested exact restored pair followed by throw cannot consume inherited permission", async () => {
    await fixture("existing Writer", (f) => {
      let token: DraftAckRead | undefined, outer: State | undefined, before: State | undefined, restoring = false;
      f.subscribe((state, previous) => {
        if (token || state.drafts[f.key]?.uiState !== "open") return;
        outer = state; before = previous; token = f.admit(); expect(token).toBeDefined();
        f.subscribe((next, prior) => { if (next === outer && prior === before && restoring) throw new Error("nested delivery interrupted"); });
      });
      f.subscribe((state) => {
        if (!outer || !before) return;
        if (state === outer && !restoring) { restoring = true; useDrafts.setState(before, true); }
        else if (state === before && restoring) useDrafts.setState(outer, true);
      });
      expect(() => setDraftUi(f.key, "open")).toThrow("nested delivery interrupted");
      expect(useDrafts.getState()).toBe(outer); expect(readDraftAck(token!)).toBeUndefined();
    });
  });

  it("nested UI frame keeps successor independent of stale admission cleanup", async () => {
    await fixture("existing Writer", (f) => {
      let old: DraftAckRead | undefined, successor: DraftAckRead | undefined, nested = false;
      f.subscribe((state, previous) => {
        if (!old && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") { old = f.admit(); expect(old).toBeDefined(); nested = true; setDraftUi(f.key, "collapsed"); }
        else if (nested && !successor && state.drafts[f.key]?.uiState === "collapsed") { successor = f.admit(); expect(successor).toBeDefined(); }
      });
      setDraftUi(f.key, "open");
      expect(readDraftAck(old!)).toBeUndefined(); endDraftAckRead(old!);
      expect(readDraftAck(successor!)).toBe(f.current()); expect(f.current().uiState).toBe("collapsed");
    });
  });

  it("active UI frame cannot exchange into author phase even after a pre-delivery read", async () => {
    await fixture("existing Writer", (f) => {
      let token: DraftAckRead | undefined;
      f.subscribe((state, previous) => {
        if (token || state.drafts[f.key]?.uiState !== "open" || previous.drafts[f.key]?.uiState !== "collapsed") return;
        token = f.admit(); expect(token).toBeDefined(); expect(readDraftAck(token!)).toBe(state.drafts[f.key]);
        const phase = beginForwardEmptyOwnerRead(token!);
        try { expect(phase).toBeUndefined(); } finally { if (phase) endDraftAckRead(phase); }
      });
      setDraftUi(f.key, "open"); expect(readDraftAck(token!)).toBe(f.current());
    });
  });

  it("closed receipt admits ordinary real Writer ACK without reviving an ended proof", async () => {
    await fixture("existing Writer", async (f) => {
      let token: DraftAckRead | undefined;
      f.subscribe((state, previous) => {
        if (!token && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") token = f.admit();
      });
      setDraftUi(f.key, "open"); expect(token).toBeDefined(); expect(readDraftAck(token!)).toBe(f.current());
      const before = f.current(), count = f.requests.length;
      await flushDraft(f.key);
      expect(f.requests).toHaveLength(count + 1); expect(readDraftAck(token!)).toBe(f.current());
      expect(f.current()).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision + 1, uiState: "open", ...body });
      endDraftAckRead(token!); expect(readDraftAck(token!)).toBeUndefined();
    });
  });
});

describe("the writer", () => {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };
  const body = { bodyText: "retained authored body", bodyHtml: "<p><b>retained authored body</b></p>" };
  const scenarios = ["throw then flush", "ordinary deadline", "source recovers during publication", "no-op", "held", "recovery", "unsaved", "nested forget", "nested successor", "nested stopping"] as const;

  for (const adapter of ["SQL", "IDB"] as const) for (const scenario of scenarios) {
    it(`${adapter}: UI publication retains Writer work through ${scenario}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-ui-writer-")), name = crypto.randomUUID();
      const open = () => adapter === "SQL" ? Promise.resolve(new SqlMailStore(openDatabase(join(dir, "mail.db")))) : IdbMailStore.open({ name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } });
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
            expect(await reservation).toMatchObject({ key, uiState: "open", id: saved.id, generation: saved.generation, revision: 2, savedRev: before.localRev + 1, localRev: before.localRev + 1, ...body });
            expect(await draftForSend(key)).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(1);
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
          drainedReservations = await Promise.allSettled(reservation ? [reservation] : []); drainedRequests = await Promise.allSettled(pending);
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
});

describe("the tail", () => {
  type State = ReturnType<typeof useDrafts.getState>;
  const body = { bodyText: "exact authored work", bodyHtml: "<p>exact authored work</p>" };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  async function fixture(run: (f: {
    key: string;
    state(): State;
    admit(): DraftAckRead | undefined;
    subscribe(listener: (state: State, previous: State) => void): void;
    clock(callback: () => void): void;
    requests: unknown[];
  }) => void | Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "terno-ui-tail-"));
    const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "ui-tail-r3", origin: "renderer" }); const client = new RpcClient(c);
    const pending = new Set<Promise<unknown>>(), failures: unknown[] = [], requests: unknown[] = [], responses: unknown[] = [];
    const subscriptions: Array<() => void> = [], tokens: DraftAckRead[] = [];
    let key: string | undefined, clock: (() => void) | undefined;
    setDraftTransport((method, params) => {
      if (method !== "drafts.save") throw new Error("Unexpected tail transport method");
      const input = contract["drafts.save"].params.parse(params); requests.push(input);
      const request = client.call("drafts.save", input); pending.add(request);
      void request.then((result) => { responses.push(result); pending.delete(request); }, (error: unknown) => { failures.push(error); pending.delete(request); });
      return request;
    }, () => { const callback = clock; clock = undefined; callback?.(); return Date.now(); });
    try {
      const [accountId] = await withAccounts(store);
      key = createDraft({ ...newFields(accountId!), ...body, uiState: "collapsed", toText: "authored@example.test" });
      expect(editDraft(key, { subject: "authored subject", subjectEdited: true })).toBe(true);
      await flushDraft(key); // Real existing Writer; its ordinary save clears dirtySince/timer before the clock arm.
      const target = key, before = useDrafts.getState().drafts[target]!;
      expect(before).toMatchObject({ status: "saved", uiState: "collapsed", ...body }); expect(before.id).not.toBeNull(); expect(before.generation).toBeTruthy();
      await run({ key: target, state: useDrafts.getState,
        admit: () => { const a = beginDraftAckRead(useDrafts.getState().drafts[target]!); const token = a.kind === "proof" ? a.proof : a.kind === "no-writer" ? a.continuity : undefined; if (token) tokens.push(token); return token; },
        subscribe: (listener) => { subscriptions.push(useDrafts.subscribe(listener)); },
        clock: (callback) => { expect(clock).toBeUndefined(); clock = callback; }, requests,
      });
      expect(useDrafts.getState().drafts[target]).toMatchObject({ key: target, id: before.id, generation: before.generation, ...body });
    } finally {
      clock = undefined; for (const off of subscriptions) off(); for (const token of tokens) endDraftAckRead(token); if (key) forgetDraft(key);
      try { const drained = await Promise.allSettled(pending); expect.soft(drained.filter((r) => r.status === "rejected")).toEqual([]); }
      finally {
        setDraftTransport(async () => { throw new Error("No active tail transport"); }, Date.now); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); expect.soft(failures).toEqual([]); expect.soft(responses).toHaveLength(requests.length); expect.soft(responses).not.toContain(null); }
      }
    }
  }

  for (const child of [true, false]) it(`UI tail: aliased raw delivery ${child ? "with" : "without"} genuine child cannot spend completed native receipt`, async () => {
    await fixture((f) => {
      const q = f.state(); let raw: State | undefined, z: State | undefined, token: DraftAckRead | undefined;
      let nativeReturns = 0, rawEntered = 0, attempted = 0, childPublications = 0, clockHits = 0;
      const phases: string[] = [];
      f.subscribe((state, previous) => {
        if (!raw && state.drafts[f.key]?.uiState === "open" && previous === q) { nativeReturns++; phases.push("native-subscriber-returned"); }
        if (raw && state === raw && previous === q && !rawEntered) {
          rawEntered++; phases.push("raw-entered");
          if (child) { setDraftUi(f.key, "open"); z = f.state(); phases.push("child-returned"); }
          else z = raw;
        }
        if (raw && previous === raw && state.drafts[f.key]?.uiState === "open") childPublications++;
      });
      f.subscribe((state, previous) => {
        if (!raw || !z || state !== z || previous !== q || attempted) return;
        attempted++; phases.push("admission"); token = f.admit();
      });
      f.clock(() => {
        clockHits++; expect(nativeReturns).toBe(1); phases.push("schedule-clock");
        useDrafts.setState(q, true); phases.push("restore-returned");
        raw = { ...q, drafts: { ...q.drafts, [f.key]: { ...q.drafts[f.key]!, subject: "raw shell subject" } } };
        useDrafts.setState(raw, true); phases.push("raw-returned");
      });
      setDraftUi(f.key, "open");
      expect(clockHits).toBe(1); expect(rawEntered).toBe(1); expect(attempted).toBe(1); expect(childPublications).toBe(child ? 1 : 0);
      expect(phases.indexOf("native-subscriber-returned")).toBeLessThan(phases.indexOf("schedule-clock"));
      expect(phases.indexOf("admission")).toBeLessThan(phases.indexOf("raw-returned"));
      if (child) { expect(z?.drafts[f.key]?.uiState).toBe("open"); expect(token).toBeDefined(); }
      expect(token ? readDraftAck(token) : undefined).toBeUndefined();
    });
  });

  it("UI tail: actual inherited outer delivery after genuine child close still admits", async () => {
    await fixture(async (f) => {
      const q = f.state(); let child: State | undefined, token: DraftAckRead | undefined, entered = 0, attempted = 0;
      f.subscribe((state, previous) => { if (!entered && previous === q && state.drafts[f.key]?.uiState === "open") { entered++; setDraftUi(f.key, "collapsed"); child = f.state(); } });
      f.subscribe((state, previous) => {
        if (!child || state !== child || previous !== q || attempted) return;
        attempted++; token = f.admit(); expect(token).toBeDefined(); expect(readDraftAck(token!)).toBe(state.drafts[f.key]);
        expect(beginForwardEmptyOwnerRead(token!)).toBeUndefined();
      });
      setDraftUi(f.key, "open"); expect(entered).toBe(1); expect(attempted).toBe(1); expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
      const before = f.state().drafts[f.key]!, count = f.requests.length;
      await flushDraft(f.key); expect(f.requests).toHaveLength(count + 1); expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
      expect(f.state().drafts[f.key]).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision + 1, uiState: "collapsed", ...body });
    });
  });

  it("UI tail: post-notification clock throw does not undo completed receipt", async () => {
    await fixture(async (f) => {
      let token: DraftAckRead | undefined, hits = 0;
      f.subscribe((state, previous) => { if (!token && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") token = f.admit(); });
      const error = new Error("expected schedule clock failure"); f.clock(() => { hits++; throw error; });
      expect(() => setDraftUi(f.key, "open")).toThrow(error); expect(hits).toBe(1); expect(token).toBeDefined();
      expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
      await flushDraft(f.key); expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
    });
  });

  it("UI tail: nested successor survives old tail throw and captured-token cleanup", async () => {
    await fixture(async (f) => {
      let old: DraftAckRead | undefined, successor: DraftAckRead | undefined, entered = 0;
      f.subscribe((state, previous) => {
        if (!old && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") old = f.admit();
        else if (entered && !successor && state.drafts[f.key]?.uiState === "collapsed" && previous.drafts[f.key]?.uiState === "open") successor = f.admit();
      });
      const error = new Error("expected older schedule tail failure");
      f.clock(() => { entered++; setDraftUi(f.key, "collapsed"); expect(successor).toBeDefined(); throw error; });
      expect(() => setDraftUi(f.key, "open")).toThrow(error); expect(entered).toBe(1); expect(old).toBeDefined(); expect(successor).toBeDefined();
      expect(readDraftAck(old!)).toBeUndefined(); endDraftAckRead(old!);
      expect(readDraftAck(successor!)).toBe(f.state().drafts[f.key]);
      await flushDraft(f.key); expect(readDraftAck(successor!)).toBe(f.state().drafts[f.key]);
    });
  });

  it("UI tail: actual native subscriber exception still retires its admission", async () => {
    await fixture((f) => {
      let token: DraftAckRead | undefined, clockHits = 0;
      f.subscribe((state, previous) => { if (!token && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") token = f.admit(); });
      f.subscribe((state, previous) => { if (state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") throw new Error("expected native subscriber failure"); });
      f.clock(() => { clockHits++; });
      expect(() => setDraftUi(f.key, "open")).toThrow("expected native subscriber failure");
      expect(token).toBeDefined(); expect(readDraftAck(token!)).toBeUndefined(); expect(clockHits).toBe(0);
    });
  });

  it("UI tail: ordinary clock tail and real ACK preserve completed admission", async () => {
    await fixture(async (f) => {
      let token: DraftAckRead | undefined, clockHits = 0;
      f.subscribe((state, previous) => { if (!token && state.drafts[f.key]?.uiState === "open" && previous.drafts[f.key]?.uiState === "collapsed") token = f.admit(); });
      f.clock(() => { clockHits++; }); setDraftUi(f.key, "open");
      expect(clockHits).toBe(1); expect(token).toBeDefined(); expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
      await flushDraft(f.key); expect(readDraftAck(token!)).toBe(f.state().drafts[f.key]);
    });
  });
});

describe("the parent's tail", () => {
  type State = ReturnType<typeof useDrafts.getState>;
  const body = { bodyText: "exact authored work", bodyHtml: "<p>exact authored work</p>" };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

  async function fixture(run: (f: {
    key: string;
    state(): State;
    admit(body: boolean): DraftAckRead | undefined;
    exchange(token: DraftAckRead): DraftAckRead | undefined;
    subscribe(listener: (state: State, previous: State) => void): void;
    clock(callback: () => void): void;
  }) => void | Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "terno-forward-compat-"));
    const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
    const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "forward-compat-r4", origin: "renderer" }); const client = new RpcClient(c);
    const pending = new Set<Promise<unknown>>(), failures: unknown[] = [], requests: unknown[] = [], responses: unknown[] = [];
    const subscriptions: Array<() => void> = [], tokens: DraftAckRead[] = [];
    let key: string | undefined, clock: (() => void) | undefined;
    setDraftTransport((method, params) => {
      if (method !== "drafts.save") throw new Error("Unexpected compatibility transport method");
      const input = contract["drafts.save"].params.parse(params); requests.push(input);
      const request = client.call("drafts.save", input); pending.add(request);
      void request.then((result) => { responses.push(result); pending.delete(request); }, (error: unknown) => { failures.push(error); pending.delete(request); });
      return request;
    }, () => { const callback = clock; clock = undefined; callback?.(); return Date.now(); });
    try {
      const [accountId] = await withAccounts(store);
      key = createDraft({ ...newFields(accountId!), ...body, uiState: "collapsed", toText: "authored@example.test" });
      expect(editDraft(key, { subject: "authored subject", subjectEdited: true })).toBe(true); await flushDraft(key);
      const target = key, before = useDrafts.getState().drafts[target]!;
      expect(before).toMatchObject({ status: "saved", uiState: "collapsed", ...body }); expect(before.id).not.toBeNull(); expect(before.generation).toBeTruthy();
      await run({ key: target, state: useDrafts.getState,
        admit: (body) => { const a = body ? beginComposeBodyAckRead(useDrafts.getState().drafts[target]!) : beginDraftAckRead(useDrafts.getState().drafts[target]!); const token = a.kind === "proof" ? a.proof : a.kind === "no-writer" ? a.continuity : undefined; if (token) tokens.push(token); return token; },
        exchange: (token) => { const phase = beginForwardEmptyOwnerRead(token); if (phase) tokens.push(phase); return phase; },
        subscribe: (listener) => { subscriptions.push(useDrafts.subscribe(listener)); }, clock: (callback) => { expect(clock).toBeUndefined(); clock = callback; },
      });
      expect(useDrafts.getState().drafts[target]).toMatchObject({ key: target, id: before.id, generation: before.generation, ...body });
    } finally {
      clock = undefined; for (const off of subscriptions) off(); for (const token of tokens) endDraftAckRead(token); if (key) forgetDraft(key);
      try { const drained = await Promise.allSettled(pending); expect.soft(drained.filter((r) => r.status === "rejected")).toEqual([]); }
      finally {
        setDraftTransport(async () => { throw new Error("No active compatibility transport"); }, Date.now); c.close();
        try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); expect.soft(failures).toEqual([]); expect.soft(responses).toHaveLength(requests.length); expect.soft(responses).not.toContain(null); }
      }
    }
  }

  for (const throwing of [false, true]) it(`compatibility: child tail raw alias stays terminal under active native parent${throwing ? " that throws" : ""}`, async () => {
    await fixture((f) => {
      const q = f.state(); let raw: State | undefined, z: State | undefined, token: DraftAckRead | undefined;
      let parentEntered = 0, rawEntered = 0, attempted = 0, clockHits = 0, parentReturned = false;
      const phases: string[] = [], error = new Error("expected active parent failure");
      f.subscribe((state, previous) => {
        if (!parentEntered && previous === q && state.drafts[f.key]?.uiState === "open") {
          parentEntered++; phases.push("parent-subscriber-entered");
          f.clock(() => {
            clockHits++; expect(parentReturned).toBe(false); phases.push("child-tail-clock");
            useDrafts.setState(q, true);
            raw = { ...q, drafts: { ...q.drafts, [f.key]: { ...q.drafts[f.key]!, subject: "raw child-tail subject" } } };
            useDrafts.setState(raw, true); phases.push("raw-returned");
          });
          setDraftUi(f.key, "collapsed"); phases.push("child-returned");
          if (throwing) throw error;
          parentReturned = true;
        } else if (raw && state === raw && previous === q && !rawEntered) {
          rawEntered++; setDraftUi(f.key, "open"); z = f.state();
        }
      });
      f.subscribe((state, previous) => {
        if (!z || state !== z || previous !== q || attempted) return;
        attempted++; phases.push("admitted"); token = f.admit(false); expect(token).toBeDefined();
        // Even a temporarily readable cursor cannot enter authoring while its real parent delivery is active.
        expect(f.exchange(token!)).toBeUndefined();
      });
      if (throwing) expect(() => setDraftUi(f.key, "open")).toThrow(error); else setDraftUi(f.key, "open");
      expect(parentEntered).toBe(1); expect(rawEntered).toBe(1); expect(clockHits).toBe(1); expect(attempted).toBe(1);
      expect(phases.indexOf("admitted")).toBeLessThan(phases.indexOf("raw-returned"));
      expect(phases.indexOf("child-tail-clock")).toBeLessThan(phases.indexOf("child-returned"));
      expect(token).toBeDefined(); expect(readDraftAck(token!)).toBeUndefined();
    });
  });
});
