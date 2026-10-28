import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { beginDraftAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, readDraftAck, setDraftTransport, setDraftUi, useDrafts, type DraftAckRead } from "./drafts";

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
