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
import { acquireDraftHold, attachBody, beginDraftAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, loadDrafts, readDraftAck, setDraftTransport, setDraftUi, useDrafts, type DraftAckRead, type LocalDraft } from "./drafts";

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
