import { expect, it, vi } from "vitest";
import { acquireDraftHold, attachBody, beginDraftAckRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, materialize, readDraftAck, setDraftTransport, setDraftUi, useDrafts, type DraftAckRead, type LocalDraft } from "./drafts";
import { newFields } from "./compose-fields";

const gate = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const beginProof = (draft: LocalDraft): DraftAckRead => { const result = beginDraftAckRead(draft); expect(result.kind).toBe("proof"); if (result.kind !== "proof") throw new Error("Expected a writer proof"); return result.proof; };

it.each(["normal", "edit", "restore", "UI roundtrip", "hold", "hold roundtrip", "conflict", "missing", "error", "unrelated", "source change", "stale end"] as const)("ACK proof tracks exact writer ownership: %s", async (scenario) => {
  const key = createDraft(newFields(1)), pending = gate<unknown>();
  let params: Record<string, unknown> = {}, other: string | undefined, release: (() => void) | null = null;
  setDraftTransport((_method, p) => { params = p as Record<string, unknown>; return pending.promise; });
  try {
    editDraft(key, { bodyText: "original" });
    const saving = flushDraft(key);
    const initial = useDrafts.getState().drafts[key]!;
    expect(initial.status).toBe("saving");
    const proof = beginProof(initial); expect(proof).toBeDefined();
    if (scenario === "edit" || scenario === "restore") {
      editDraft(key, { bodyText: "later" });
      if (scenario === "restore") editDraft(key, { bodyText: "original" });
    } else if (scenario === "UI roundtrip") {
      setDraftUi(key, "collapsed"); setDraftUi(key, "open");
    } else if (scenario === "hold" || scenario === "hold roundtrip") {
      release = acquireDraftHold(); expect(release).not.toBeNull();
      if (scenario === "hold roundtrip") { release!(); release = null; }
    } else if (scenario === "unrelated") other = createDraft(newFields(1));
    else if (scenario === "source change") { const body = attachBody(key, () => ({ text: "later", html: "<p>later</p>" })); body.changed(); body.changed(); }
    else if (scenario === "stale end") { const successor = beginProof(initial); expect(successor).toBeDefined(); endDraftAckRead(proof!); expect(readDraftAck(successor!)).toBe(initial); endDraftAckRead(successor!); }
    if (scenario === "error") pending.reject(new Error("save failed"));
    else if (scenario === "missing") pending.resolve(null);
    else pending.resolve({ ...params, id: 7, generation: "stable", revision: scenario === "conflict" ? 2 : 1, updatedAt: 0 });
    await saving;
    if (scenario === "normal" || scenario === "unrelated") expect(readDraftAck(proof!)).toMatchObject({ id: 7, generation: "stable", revision: 1, bodyText: "original" });
    else expect(readDraftAck(proof!)).toBeUndefined();
    if (scenario === "edit") expect(useDrafts.getState().drafts[key]?.bodyText).toBe("later");
    if (scenario === "source change") expect(materialize(key)?.bodyText).toBe("later");
    endDraftAckRead(proof!);
  } finally { release?.(); pending.resolve(null); forgetDraft(key); if (other) forgetDraft(other); setDraftTransport(async () => null); }
});

it("retains proof across a writer's queued second save", async () => {
  const key = createDraft(newFields(1));
  const first = gate<unknown>(), second = gate<unknown>();
  const requests: Record<string, unknown>[] = [];
  setDraftTransport((_method, params) => {
    requests.push(params as Record<string, unknown>);
    return requests.length === 1 ? first.promise : second.promise;
  });
  let proof: DraftAckRead | undefined;
  let saving: Promise<void> | undefined;
  try {
    editDraft(key, { bodyText: "first" });
    saving = flushDraft(key);
    editDraft(key, { bodyText: "second" });
    proof = beginProof(useDrafts.getState().drafts[key]!);
    expect(proof).toBeDefined();
    first.resolve({ ...requests[0], id: 7, generation: "stable", revision: 1, updatedAt: 0 });
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ id: 7, generation: "stable", baseRevision: 1, bodyText: "second" });
    expect(readDraftAck(proof!)).toMatchObject({ id: 7, revision: 1, status: "saving", bodyText: "second" });
    second.resolve({ ...requests[1], id: 7, generation: "stable", revision: 2, updatedAt: 0 });
    await saving;
    expect(readDraftAck(proof!)).toMatchObject({ id: 7, revision: 2, status: "saved", bodyText: "second" });
  } finally {
    first.resolve(null); second.resolve(null);
    await saving;
    if (proof) endDraftAckRead(proof);
    forgetDraft(key); setDraftTransport(async () => null);
  }
});

it("persists a first draft when a saving observer collapses it", async () => {
  const key = createDraft(newFields(1));
  const requests: Record<string, unknown>[] = [];
  setDraftTransport(async (_method, params) => {
    requests.push(params as Record<string, unknown>);
    return { ...params as Record<string, unknown>, id: 7, generation: "stable", revision: 1, updatedAt: 0 };
  });
  let stop = () => {};
  try {
    editDraft(key, { bodyText: "authored" });
    stop = useDrafts.subscribe((state, previous) => {
      if (state.drafts[key]?.status === "saving" && previous.drafts[key]?.status !== "saving") {
        stop(); setDraftUi(key, "collapsed");
      }
    });
    await flushDraft(key);
    expect(requests).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ id: 7, bodyText: "authored", uiState: "collapsed", status: "saved" });
  } finally { stop(); forgetDraft(key); setDraftTransport(async () => null); }
});

it("does not lose a scheduled first save when a saving observer collapses it", async () => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1));
  const requests: Record<string, unknown>[] = [];
  setDraftTransport(async (_method, params) => {
    requests.push(params as Record<string, unknown>);
    return { ...params as Record<string, unknown>, id: 7, generation: "stable", revision: 1, updatedAt: 0 };
  });
  let stop = () => {};
  try {
    editDraft(key, { bodyText: "authored" });
    stop = useDrafts.subscribe((state, previous) => {
      if (state.drafts[key]?.status === "saving" && previous.drafts[key]?.status !== "saving") {
        stop(); setDraftUi(key, "collapsed");
      }
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(requests).toHaveLength(1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ id: 7, bodyText: "authored", uiState: "collapsed", status: "saved" });
  } finally { stop(); forgetDraft(key); setDraftTransport(async () => null); vi.useRealTimers(); }
});

it("rejects a target replaced and restored by an earlier ACK observer", async () => {
  const key = createDraft(newFields(1)), pending = gate<unknown>();
  let params: Record<string, unknown> = {};
  setDraftTransport((_method, value) => { params = value as Record<string, unknown>; return pending.promise; });
  let stop = () => {}, proof: DraftAckRead | undefined, saving: Promise<void> | undefined;
  try {
    editDraft(key, { bodyText: "authored" });
    saving = flushDraft(key);
    stop = useDrafts.subscribe((state, previous) => {
      const current = state.drafts[key];
      if (current?.status === "saved" && previous.drafts[key]?.status === "saving") {
        stop();
        useDrafts.setState({ drafts: { ...state.drafts, [key]: { ...current, bodyText: "replacement" } } });
        useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: current } }));
      }
    });
    proof = beginProof(useDrafts.getState().drafts[key]!);
    expect(proof).toBeDefined();
    pending.resolve({ ...params, id: 7, generation: "stable", revision: 1, updatedAt: 0 });
    await saving;
    expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "authored", status: "saved" });
    expect(readDraftAck(proof!)).toBeUndefined();
  } finally {
    stop(); pending.resolve(null); await saving;
    if (proof) endDraftAckRead(proof);
    forgetDraft(key); setDraftTransport(async () => null);
  }
});
