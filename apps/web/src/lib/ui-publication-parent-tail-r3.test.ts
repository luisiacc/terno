// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract, createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { beginComposeBodyAckRead, beginDraftAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, readDraftAck, setDraftTransport, setDraftUi, useDrafts, type DraftAckRead } from "./drafts";

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
