/** Plan 242: Dev mode's Summarize again, in the window's store: what a request goes back to, and what it asks again. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSummary } from "@terno/core";

const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  answer: (() => Promise.resolve(null)) as (method: string, params: Record<string, unknown>) => Promise<unknown>,
}));
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: Record<string, unknown>) => {
      rpc.calls.push({ method, params });
      return rpc.answer(method, params);
    },
  },
}));

// what Clear AI data also forgets; nothing here reaches it
vi.mock("~/lib/ask", () => ({ forgetAsk: () => {} }));

const { bodyArrivedForSummary, dismissSummary, noteShown, stopSummary, summarize, useSummaries } = await import("./summaries");

const T = 7;
const card = (summary: string): AiSummary => ({ threadId: T, summary, items: [], provider: "openai", model: "m", generatedAt: 1 });
const STORED = card("What was stored.");
const NEW = card("Written again.");
const ui = () => useSummaries.getState().byThread.get(T);
const asked = (method: string) => rpc.calls.filter((c) => c.method === method);
function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.answer = (method) => Promise.resolve(method === "ai.summaries.get" ? { state: "ready", summary: STORED } : { status: "ready", summary: NEW });
  useSummaries.setState({ byThread: new Map([[T, { kind: "ready", summary: STORED }]]), open: false });
});

describe("plan 242: Summarize again", () => {
  it("shown already, the ordinary button only opens the block; again asks, with the block open", async () => {
    await summarize(T);
    expect(rpc.calls).toEqual([]);
    expect(useSummaries.getState().open).toBe(true);
    useSummaries.setState({ open: false });
    const pending = summarize(T, { again: true });
    expect(useSummaries.getState().open).toBe(true);
    expect(ui()).toMatchObject({ kind: "running", again: true });
    await pending;
    expect(asked("ai.summarize")).toEqual([{ method: "ai.summarize", params: expect.objectContaining({ threadId: T, again: true }) }]);
    expect(ui()).toEqual({ kind: "ready", summary: NEW });
  });

  it("stopped or cancelled, what was stored comes back", async () => {
    const answer = deferred<unknown>();
    rpc.answer = (method) => (method === "ai.summarize" ? answer.promise : Promise.resolve({ state: "ready", summary: STORED }));
    void summarize(T, { again: true });
    stopSummary(T);
    expect(asked("ai.cancel")).toHaveLength(1);
    await settle();
    expect(ui()).toEqual({ kind: "ready", summary: STORED });

    const cancelled = deferred<unknown>();
    rpc.answer = (method) => (method === "ai.summarize" ? cancelled.promise : Promise.resolve({ state: "ready", summary: STORED }));
    const pending = summarize(T, { again: true });
    cancelled.reject({ code: "CANCELLED" });
    await pending;
    await settle();
    expect(ui()).toEqual({ kind: "ready", summary: STORED });
  });

  it("failed, its error remembers it was again, and dismissing it brings the stored one back", async () => {
    rpc.answer = (method) => (method === "ai.summarize" ? Promise.reject({ message: "Down", details: { aiErrorKind: "unavailable" } }) : Promise.resolve({ state: "ready", summary: STORED }));
    await summarize(T, { again: true });
    expect(ui()).toMatchObject({ kind: "error", again: true, was: "none" });
    // the toolbar's button, pressed on the error rather than Try again, still asks again (Codex review)
    await summarize(T);
    expect(asked("ai.summarize").map((c) => c.params.again)).toEqual([true, true]);
    dismissSummary(T);
    await settle();
    expect(ui()).toEqual({ kind: "ready", summary: STORED });
  });

  it("waiting for the text, it asks again once it's here", async () => {
    rpc.answer = (method) => Promise.resolve(method === "ai.summarize" && asked("ai.summarize").length === 1 ? { status: "waitingBody" } : { status: "ready", summary: NEW });
    await summarize(T, { again: true });
    expect(ui()).toMatchObject({ kind: "waitingBody", again: true });
    bodyArrivedForSummary(T);
    await settle();
    expect(asked("ai.summarize").map((c) => c.params.again)).toEqual([true, true]);
    expect(ui()).toEqual({ kind: "ready", summary: NEW });
  });

  it("a read of what was stored that lands after the new summary doesn't put the old one back", async () => {
    const read = deferred<unknown>();
    rpc.answer = (method) => (method === "ai.summaries.get" ? read.promise : method === "ai.summarize" && asked("ai.summarize").length === 1 ? Promise.reject({ message: "Down", details: { aiErrorKind: "unavailable" } }) : Promise.resolve({ status: "ready", summary: NEW }));
    await summarize(T, { again: true });
    // Try again: the error goes, its read of the stored one is sent, and the request is made at once
    dismissSummary(T);
    await summarize(T, { again: true });
    expect(ui()).toEqual({ kind: "ready", summary: NEW });
    read.resolve({ state: "ready", summary: STORED });
    await settle();
    expect(ui()).toEqual({ kind: "ready", summary: NEW });
  });
});

describe("plan 279: a summary by hand starts at what the showing drew unread", () => {
  const m = (id: number, isRead: boolean, isSent = false) => ({ id, isRead, isSent });

  it("sends the earliest unread message someone else wrote; a later copy drawn read keeps it, and a new showing starts again", async () => {
    useSummaries.setState({ byThread: new Map() });
    noteShown(T, [m(1, true), m(2, true), m(3, false)], true);
    // a cached copy came back with an earlier one unread, then the dwell read them all
    noteShown(T, [m(1, true), m(2, false), m(3, false)], false);
    noteShown(T, [m(1, true), m(2, true), m(3, true)], false);
    await summarize(T);
    expect(asked("ai.summarize").at(-1)!.params.since).toBe(2);
    // your own unread message is never it; a new showing with nothing unread sends nothing
    noteShown(T, [m(1, true), m(4, false, true)], true);
    useSummaries.setState({ byThread: new Map() });
    await summarize(T);
    expect(asked("ai.summarize").at(-1)!.params).not.toHaveProperty("since");
  });

  it("a reminder left unread further up doesn't take in what was read after it, and trash or spam is never it (Codex code review 2, 6)", async () => {
    useSummaries.setState({ byThread: new Map() });
    noteShown(T, [m(1, true), m(2, false), m(3, true), m(4, false)], true);
    await summarize(T);
    expect(asked("ai.summarize").at(-1)!.params.since).toBe(4);
    useSummaries.setState({ byThread: new Map() });
    noteShown(T, [m(1, true), { ...m(2, false), isTrash: true }, m(3, false), { ...m(5, false), isSpam: true }], true);
    await summarize(T);
    expect(asked("ai.summarize").at(-1)!.params.since).toBe(3);
  });
});
