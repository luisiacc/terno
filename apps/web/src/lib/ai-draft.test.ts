// @vitest-environment jsdom
/**
 * Plan 133 §10.4: each race, on the real draft store and a stand-in for the editor. What the editor itself does with
 * the text is in composer/generated.test.ts; the whole of it, in a page, in e2e/ai-draft.spec.ts.
 */
import type { PreparedReply } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, AiComposeResult } from "@terno/core";

type Call = { method: string; params: Record<string, unknown>; resolve(v: unknown): void; reject(e: unknown): void };
const rpc = vi.hoisted(() => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { calls: [] as Call[], events: new Map<string, (payload: unknown) => void>(), deferred: new Set<string>() };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
      rpc.calls.push({ method, params, resolve, reject });
      if (method === "drafts.save" && !rpc.deferred.has(method)) resolve({ ...params, id: params.id ?? 42, generation: params.generation ?? "identity", revision: Number(params.baseRevision ?? 0) + 1 });
      else if (method === "writing.commitGeneration" && !rpc.deferred.has(method)) resolve({ ok: true });
      else if (method === "ai.cancel" || method === "ai.composeEnd") resolve({ ok: true });
      else if (method === "compose.send") resolve({ messageId: 9, threadId: 7 });
      else if (method === "compose.schedule") resolve({ ok: true });
    }),
    on: (event: string, listener: (payload: unknown) => void) => { rpc.events.set(event, listener); return () => {}; },
  },
}));
const threads = vi.hoisted(() => ({ listeners: new Set<(state: unknown) => void>() }));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn(async () => null), useThreads: { subscribe: (l: (state: unknown) => void) => { threads.listeners.add(l); return () => threads.listeners.delete(l); } } }));

const store = await import("./ai-draft");
const { aiDraftHooks, noteState, setGlance, useAiDraftUi } = await import("./ai-draft-state");
const { sendDraft } = await import("./compose");
const { newFields } = await import("./compose-fields");
const drafts = await import("./drafts");
const { registerController } = await import("~/components/composer/controller");
const { registerDraftCommands } = await import("./draft-commands");
const { getApp, setApp } = await import("~/state/app");
const { setLocale } = await import("@terno/i18n");
const en = (await import("@terno/i18n/locales/en")).default;

const { createDraft, editDraft, editDraftRecipients, flushDraft, forgetDraft, markDraftMissing, useDrafts } = drafts;
const tick = () => new Promise((r) => setTimeout(r, 0));
if (!globalThis.CSS) (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s) => s };

function editor(key: string, initial = "") {
  const history: { text: string; doc: object }[] = [];
  const future: { text: string; doc: object }[] = [];
  const listeners = new Set<() => void>();
  const c = {
    text: initial,
    doc: {} as object,
    placeholder: undefined as string | undefined,
    gaps: [] as readonly string[],
    selected: null as string | null,
    focused: 0,
    insertGenerated(text: string, how: "replace" | "below", placeholder?: string, gaps?: readonly string[]) {
      const before = { text: c.text };
      history.push({ text: c.text, doc: c.doc });
      c.text = how === "replace" || !c.text ? text : `${c.text}\n\n${text}`;
      c.doc = { text: c.text };
      c.placeholder = placeholder;
      c.gaps = gaps ?? [];
      // as the real editor's change does: the draft is dirty, autosave follows, and its listeners hear of it at once
      editDraft(key, {});
      for (const l of listeners) l();
      return { doc: c.doc, before };
    },
    // as the real one: the document as the write found it, one step that undo takes back
    restoreGenerated(before: unknown) {
      history.push({ text: c.text, doc: c.doc });
      c.text = (before as { text: string }).text;
      c.doc = { text: c.text };
      for (const l of listeners) l();
      return { doc: c.doc };
    },
    // the content, marks included, as the real one's doc.eq
    sameDoc: (doc: unknown) => JSON.stringify(doc) === JSON.stringify(c.doc),
    selectText(text: string) {
      if (!c.text.includes(text)) return false;
      c.selected = text;
      return true;
    },
    undoGenerated(doc: unknown) {
      if (c.doc !== doc) return null;
      future.push({ text: c.text, doc: c.doc });
      c.text = history.pop()!.text;
      c.doc = { text: c.text };
      for (const l of listeners) l();
      return { doc: c.doc };
    },
    docToken: () => c.doc,
    subscribeDoc(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
    empty: () => !c.text,
    dismissGhost() {},
    snapshot: () => ({ html: "", text: c.text }),
    focus() { c.focused++; },
    type(text: string) { c.text += text; c.doc = { text: c.text }; for (const l of listeners) l(); },
    // ⌘⇧Z: the step undo took back
    redo() { history.push({ text: c.text, doc: c.doc }); c.text = future.pop()!.text; c.doc = { text: c.text }; for (const l of listeners) l(); },
    dom: document.createElement("div"),
    getState: () => ({}),
    subscribe: () => () => {},
    // plan 163: the body as one block (a document position is its offset plus one), and fills as text
    bodyText: () => ({ text: c.text, images: false, truncated: false, runs: c.text ? [{ at: 0, pos: 1, len: c.text.length }] : [], quoted: [] }),
    fill: null as null | { run: string; gaps: { from: number; to: number; text: string; spoiled: boolean }[]; streamed: Map<number, { text: string; done: boolean }> },
    filled: [] as string[],
    startFill(run: string, gaps: readonly { from: number; to: number }[]) {
      c.fill = { run, gaps: gaps.map((g) => ({ ...g, text: c.text.slice(g.from - 1, g.to - 1), spoiled: false })), streamed: new Map() };
      return true;
    },
    streamFill(run: string, n: number, text: string, done: boolean) { if (c.fill?.run === run) c.fill.streamed.set(n, { text, done }); },
    fillRun: () => c.fill?.run ?? null,
    fillsSoFar(run: string) { return c.fill?.run === run ? c.fill.gaps.map((_, i) => { const f = c.fill!.streamed.get(i + 1); return f?.done ? f.text : null; }) : []; },
    endFill(run: string) { if (c.fill?.run === run) c.fill = null; },
    clearFilled() { c.filled = []; },
    commitFill(run: string, fills: readonly (string | null)[], o: { onlyDone?: boolean } = {}) {
      if (c.fill?.run !== run) return null;
      const before = { text: c.text };
      const gaps = c.fill.gaps.map((g) => ({ ...g, spoiled: g.spoiled || !c.text.includes(g.text) }));
      const chosen = gaps.filter((g, i) => !g.spoiled && fills[i] && (!o.onlyDone || c.fill!.streamed.get(i + 1)?.done));
      const left = gaps.filter((g) => !g.spoiled && !chosen.includes(g)).map((g) => g.text);
      history.push({ text: c.text, doc: c.doc });
      let text = c.text;
      for (const g of chosen) text = text.replace(g.text, fills[gaps.indexOf(g)]!);
      c.text = text;
      c.doc = { text: c.text };
      c.filled = chosen.map((g) => fills[gaps.indexOf(g)]!);
      c.gaps = left;
      c.fill = null;
      for (const l of listeners) l();
      return { doc: c.doc, before, gaps: gaps.filter((g) => !g.spoiled).map(({ from, to }) => ({ from, to })), applied: chosen.length, left };
    },
    refill(base: unknown, gaps: readonly { from: number; to: number }[], fills: readonly (string | null)[]) {
      const b = (base as { text: string }).text;
      const before = { text: c.text };
      let text = b;
      const words = gaps.map((g) => b.slice(g.from - 1, g.to - 1));
      words.forEach((w, i) => { if (fills[i]) text = text.replace(w, fills[i]!); });
      history.push({ text: c.text, doc: c.doc });
      c.text = text;
      c.doc = { text: c.text };
      for (const l of listeners) l();
      return { doc: c.doc, before, applied: fills.filter(Boolean).length, left: words.filter((_, i) => !fills[i]) };
    },
  };
  const stop = registerController(key, c as never);
  const unsub = c.subscribeDoc(() => store.noteBody(key));
  return { c, unmount() { stop(); unsub(); } };
}

const done = (text: string, over: Partial<Extract<AiComposeResult, { status: "done" }>> = {}): AiComposeResult => ({
  status: "done", text, subject: null, stop: "end",
  used: { levels: ["you", "account"], personFromOtherAccount: false, examples: 0, pastConversations: 0, mentions: 0, threadMessages: 2, history: "found", learning: false, inboundSnippetOnly: false, language: "en", languageReason: "inbound", provider: "fake", model: "demo", reused: false },
  checks: { specifics: [], placeholders: [] },
  ...over,
});

const last = (method: string) => [...rpc.calls].reverse().find((c) => c.method === method)!;
const calls = (method: string) => rpc.calls.filter((c) => c.method === method);
const session = (key: string) => store.useAiDraft.getState().sessions[key];

/** A reply with Ana on it, opened by ⌘J and past the row: the model is writing. */
async function writing(o: { body?: string; mode?: "reply" | "new"; to?: string } = {}) {
  const mode = o.mode ?? "reply";
  const key = createDraft({ ...newFields(1), mode, threadId: mode === "new" ? null : 7, inReplyToMessageId: mode === "new" ? null : 3, toText: o.to ?? "Ana Pérez <ana@example.test>", subject: mode === "new" ? "" : "Re: Contract", bodyText: o.body ?? "" });
  const view = editor(key, o.body ?? "");
  await store.openRow({ key });
  store.setInstruction(key, "");
  await store.submit(key);
  await tick();
  expect(session(key)!.phase).toBe("writing");
  return { key, ...view };
}

const delta = (key: string, text: string) => rpc.events.get("aiCompose")!({ requestId: session(key)!.run!.requestId, text });

beforeEach(() => {
  setLocale("en", en as never);
  rpc.calls.length = 0;
  rpc.deferred.clear();
  useDrafts.setState({ drafts: {} });
  store.useAiDraft.setState({ sessions: {} });
  useAiDraftUi.setState({ rows: {}, enabled: true });
  setApp({
    accounts: [{ id: 1, email: "me@example.test" } as Account, { id: 2, email: "work@example.test" } as Account],
    settings: { ai: { provider: "fake", model: "demo", local: true, tasks: {}, keys: {}, hasKey: false, keyConfirmed: false, profiles: {} } } as never,
    compose: null,
  });
  globalThis.localStorage?.clear?.();
});
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); });

describe("the stream", () => {
  it("stays out of the document and the draft: deltas are only the preview's, until one commit", async () => {
    const { key, c } = await writing();
    delta(key, "Hi ");
    delta(key, "Ana");
    expect(store.previewText(key)).toBe("Hi Ana");
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("");
    expect(store.previewMode(session(key))).toBe("overlay");
    last("ai.compose").resolve(done("Hi Ana,\n\nFine."));
    await tick();
    expect(c.text).toBe("Hi Ana,\n\nFine.");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.live).toBe("Draft ready, 3 words");
    expect(store.previewText(key)).toBe("");
  });

  it("screen readers hear that it started, never the deltas", async () => {
    const { key } = await writing();
    const live = session(key)!.live;
    delta(key, "Hi");
    delta(key, " there");
    expect(live).toBe("Writing draft");
    expect(session(key)!.live).toBe(live);
  });

  it("commits what the call returned, not the stream's concatenation", async () => {
    const { key, c } = await writing();
    delta(key, "<partial thinking>");
    last("ai.compose").resolve(done("The answer."));
    await tick();
    expect(c.text).toBe("The answer.");
  });

  it("ghost text is off while a preview is up", async () => {
    const { key } = await writing();
    expect(aiDraftHooks.busy(key)).toBe(true);
    last("ai.compose").resolve(done("x"));
    await tick();
    expect(aiDraftHooks.busy(key)).toBe(false);
  });
});

describe("§10.4: binding and races", () => {
  it("coming back with its source gone: its AI work stays, and the strip has it, not that row (plan 158)", async () => {
    const { key } = await writing();
    useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, showSourceContext: true, presentationExpired: true, departedThreadId: 7 } } }));
    setApp({ selectedId: 8 });
    setApp({ selectedId: 7 });
    await tick();
    rpc.calls.findLast((c) => c.method === "drafts.sourceContext")!.resolve(null);
    await tick();
    expect(useDrafts.getState().drafts[key]!.homeLost).toBe(true);
    expect(session(key)).toBeDefined();
    setApp({ selectedId: null });
  });

  it("autosave mid-stream doesn't invalidate: the first save's identity is adopted, and a later one changes nothing", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    editDraft(key, { includeQuote: false });
    await flushDraft(key, true);
    await tick();
    expect(useDrafts.getState().drafts[key]!.id).toBe(42);
    expect(session(key)!.run!.binding.id).toBe(42);
    expect(session(key)!.phase).toBe("writing");
    editDraft(key, { includeQuote: true });
    await flushDraft(key, true);
    await tick();
    expect(session(key)!.phase).toBe("writing");
    expect(store.previewText(key)).toBe("Hi");
    last("ai.compose").resolve(done("Done."));
    await tick();
    expect(c.text).toBe("Done.");
    expect(session(key)!.phase).toBe("strip");
  });

  it("a superseded draft (its identity replaced after the first save) invalidates and cancels", async () => {
    const { key, c } = await writing();
    useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 42, generation: "one", revision: 1 } } }));
    expect(session(key)).toBeDefined();
    const compose = last("ai.compose");
    useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, generation: "two" } } }));
    expect(session(key)).toBeUndefined();
    expect(last("ai.cancel").params.requestId).toBe(compose.params.requestId);
    compose.resolve(done("Too late."));
    await tick();
    expect(c.text).toBe("");
  });

  it("recovery invalidates", async () => {
    const { key } = await writing();
    markDraftMissing(key);
    expect(session(key)).toBeUndefined();
    expect(calls("ai.cancel")).toHaveLength(1);
  });

  it("typing during the stream: it goes on, and the result is a suggestion, under what was typed", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    c.type("my words");
    expect(session(key)!.phase).toBe("writing");
    expect(store.previewMode(session(key))).toBe("below");
    expect(calls("ai.cancel")).toHaveLength(0);
    last("ai.compose").resolve(done("Generated."));
    await tick();
    expect(session(key)!.phase).toBe("choice");
    expect(session(key)!.choice!.reason).toBe("typed");
    expect(c.text).toBe("my words");
    store.place(key, "below");
    expect(c.text).toBe("my words\n\nGenerated.");
    expect(session(key)!.phase).toBe("strip");
  });

  it("typing and taking it all back: the text is as it was, so it commits", async () => {
    const { key, c } = await writing();
    c.type("x");
    c.text = "";
    last("ai.compose").resolve(done("Generated."));
    await tick();
    expect(c.text).toBe("Generated.");
    expect(session(key)!.phase).toBe("strip");
  });

  it.each([
    ["To", (key: string) => editDraftRecipients(key, "to", "Tom <tom@example.test>", ["tom@example.test"]), "Ana"],
    ["From", (key: string) => editDraft(key, { accountId: 2 }), null],
    ["the subject", (key: string) => editDraft(key, { subject: "Other", subjectEdited: true }), null],
  ])("%s changed: same, and it says who it was for when that's what moved", async (_what, change, writtenFor) => {
    const { key, c } = await writing();
    change(key);
    last("ai.compose").resolve(done("For Ana."));
    await tick();
    expect(session(key)!.phase).toBe("choice");
    expect(session(key)!.choice!.writtenFor).toBe(writtenFor);
    expect(c.text).toBe("");
  });

  it("a recipient list written differently but the same people is no change", async () => {
    const { key, c } = await writing();
    editDraftRecipients(key, "to", "\"Ana Pérez\" <ANA@example.test>", []);
    last("ai.compose").resolve(done("Fine."));
    await tick();
    expect(c.text).toBe("Fine.");
  });

  it("collapse: the stream goes on with no editor, and what finished waits; it goes in when the draft opens again", async () => {
    const { key, unmount } = await writing();
    delta(key, "Hi");
    unmount();
    expect(session(key)!.phase).toBe("writing");
    expect(calls("ai.cancel")).toHaveLength(0);
    last("ai.compose").resolve(done("Back.", { subject: null }));
    await tick();
    expect(session(key)!.phase).toBe("held");
    expect(useAiDraftUi.getState().rows[key]).toBe("ready");
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("");
    const again = editor(key);
    store.commitHeld(key);
    expect(again.c.text).toBe("Back.");
    expect(session(key)!.phase).toBe("strip");
  });

  it("what waited for the draft to open again keeps its subject", async () => {
    const { key, unmount } = await writing({ mode: "new" });
    unmount();
    last("ai.compose").resolve(done("Back.", { subject: "Generated" }));
    await tick();
    expect(session(key)!.phase).toBe("held");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    editor(key);
    store.commitHeld(key);
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated");
  });

  it("pin: the view is destroyed and rebuilt mid-stream; insertion goes to the controller mounted at that moment", async () => {
    const { key, c, unmount } = await writing();
    delta(key, "Hi");
    unmount();
    const rebuilt = editor(key);
    last("ai.compose").resolve(done("In the card."));
    await tick();
    expect(rebuilt.c.text).toBe("In the card.");
    expect(c.text).toBe("");
  });

  it("send or discard of the draft cancels the stream", async () => {
    const { key, c } = await writing();
    const compose = last("ai.compose");
    forgetDraft(key);
    expect(session(key)).toBeUndefined();
    expect(last("ai.cancel").params.requestId).toBe(compose.params.requestId);
    compose.resolve(done("Too late."));
    await tick();
    expect(c.text).toBe("");
  });

  it("plan 161, pass 3: Esc mid-stream stops and keeps what came, as a stopped write, before the form's collapse; Esc on the strip is the form's", async () => {
    const { key, c } = await writing();
    store.setInstruction(key, "");
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(calls("ai.cancel")).toHaveLength(1);
    // the words that came are the draft's now, said to be stopped, and Undo takes them back
    expect(c.text).toBe("Hi");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.stopped).toBe(true);
    expect(session(key)!.live).toBe("Stopped. What it wrote so far is in the draft.");
    expect(aiDraftHooks.escape(key)).toBe(false);
    store.undoCommit(key);
    expect(c.text).toBe("");
    // plan 163: no row: the body is as it was (empty here), and Esc is the form's
    expect(session(key)).toBeUndefined();
    expect(aiDraftHooks.escape(key)).toBe(false);

    await store.openRow({ key });
    await store.submit(key);
    last("ai.compose").resolve(done("Text."));
    await tick();
    expect(session(key)!.phase).toBe("strip");
    expect(aiDraftHooks.escape(key)).toBe(false);
    expect(session(key)!.phase).toBe("strip");
  });

  it("a refinement stopped halfway puts the strip back, on the text it had", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    store.refine(key, "shorter");
    expect(session(key)!.phase).toBe("writing");
    // plan 161, pass 2: the text it rewrites stays in place, dimmed, before and while the new one streams
    expect(store.previewMode(session(key))).toBe("rewriting");
    delta(key, "Sho");
    expect(store.previewMode(session(key))).toBe("rewriting");
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(session(key)!.phase).toBe("strip");
    expect(c.text).toBe("First.");
    const shorter = calls("ai.compose").at(-1)!.params;
    expect(shorter.instruction).toBe("Shorter. Keep every fact and commitment.");
    expect(shorter.previousDraft).toBe("First.");
  });

  it("plan 163: stopped before any words, the body is as it was, the instruction in it; ⌘J asks it once more", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Ana Pérez <ana@example.test>", subject: "Re: Contract", bodyText: "ask her for the address" });
    const { c } = editor(key, "ask her for the address");
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false });
    await tick();
    expect(session(key)!.phase).toBe("writing");
    store.stop(key);
    expect(session(key)).toBeUndefined();
    expect(c.text).toBe("ask her for the address");
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false });
    await tick();
    expect(last("ai.compose").params.instruction).toBe("ask her for the address");
  });

  it("plan 161, pass 3 (Codex review): a stopped write edited, then its Undo: the snack's Undo brings the edit and the stopped strip back", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    c.type(" mine");
    expect(session(key)!.strip!.edited).toBe(true);
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(session(key)).toBeUndefined();
    const { useSnack, runUndo } = await import("./snack");
    await runUndo(useSnack.getState().undo!);
    expect(c.text).toBe("Hi mine");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.stopped).toBe(true);
    expect(session(key)!.strip!.edited).toBe(true);
  });

  it("plan 161, pass 3 (Codex review): a stopped write rewritten, then Undo: it's the stopped version again, and Undo once more gives the body back", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    store.refine(key, "shorter");
    last("ai.compose").resolve(done("Hey."));
    await tick();
    expect(session(key)!.strip!.stopped).toBeFalsy();
    store.undoCommit(key);
    expect(c.text).toBe("Hi");
    expect(session(key)!.strip!.stopped).toBe(true);
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(session(key)).toBeUndefined();
  });

  it("plan 161, pass 3 (Codex review): a stopped write names the writing task's own model, not Settings' first row's", async () => {
    setApp({ settings: { ai: { provider: "fake", model: "demo", local: true, tasks: { writing: { provider: "fake", model: "chosen-writing-model" } }, keys: {}, hasKey: false, keyConfirmed: false, profiles: {} } } as never });
    const { key } = await writing();
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    expect(session(key)!.strip!.used.model).toBe("chosen-writing-model");
  });

  it("plan 163: after a stopped write's edited Undo, new words typed in the body retire the old snack's Undo", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    c.type(" mine");
    store.undoCommit(key);
    c.type("something else");
    const { useSnack, runUndo } = await import("./snack");
    await runUndo(useSnack.getState().undo!);
    expect(c.text).toBe("something else");
    expect(session(key)).toBeUndefined();
  });

  it("plan 161, pass 3 (second review): on Claude with no choice, a stopped write names the model drafts run on there", async () => {
    const { WRITING_CLAUDE_MODEL } = await import("@terno/core");
    setApp({ settings: { ai: { provider: "anthropic", model: "claude-opus-5-5", local: false, tasks: {}, keys: { anthropic: { hasKey: true } }, hasKey: true, keyConfirmed: true, profiles: {} } } as never });
    const { key } = await writing();
    delta(key, "Hi");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    expect(session(key)!.strip!.used.model).toBe(WRITING_CLAUDE_MODEL);
  });

  it("plan 161, pass 3: stopped over the user's notes, what came goes below them, and Undo leaves the notes and the instruction", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Ana Pérez <ana@example.test>", subject: "Re: Contract", bodyText: "my notes" });
    const { c } = editor(key, "my notes");
    await store.openRow({ key });
    store.setInstruction(key, "make these a reply");
    void store.submit(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false });
    await tick();
    expect(session(key)!.phase).toBe("writing");
    delta(key, "Dear Ana");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    store.stop(key);
    expect(c.text).toBe("my notes\n\nDear Ana");
    expect(session(key)!.strip!.stopped).toBe(true);
    expect(session(key)!.strip!.instruction).toBe("make these a reply");
    store.undoCommit(key);
    expect(c.text).toBe("my notes");
    expect(session(key)).toBeUndefined();
  });
});

describe("the send guard, on every path", () => {
  it("sendDraft, as buttons, shortcuts and the palette call it, stops at an undecided preview and says so", async () => {
    const { key } = await writing();
    expect(await sendDraft(key)).toBe(false);
    expect(calls("compose.send")).toHaveLength(0);
    expect(session(key)!.guard).toEqual({ sendAt: undefined });
    expect(useDrafts.getState().drafts[key]!.sending).toBe(false);
    // and again: the choice is explicit, a second ⌘↵ isn't one
    expect(await sendDraft(key)).toBe(false);
    expect(calls("compose.send")).toHaveLength(0);
  });

  it("Send Later stops there too, and remembers it was Send Later", async () => {
    const { key } = await writing();
    const at = Date.now() + 3_600_000;
    expect(await sendDraft(key, at)).toBe(false);
    expect(calls("compose.schedule")).toHaveLength(0);
    expect(session(key)!.guard).toEqual({ sendAt: at });
  });

  it("a suggestion waiting for a choice blocks; a partial kept after a failure blocks", async () => {
    const { key, c } = await writing();
    c.type("mine");
    last("ai.compose").resolve(done("Sugg."));
    await tick();
    expect(await sendDraft(key)).toBe(false);
    store.keepWriting(key);
    expect(session(key)!.guard).toBeNull();
    store.discard(key);

    await store.openRow({ key });
    await store.submit(key);
    delta(key, "Part");
    last("ai.compose").reject({ code: "AI", message: "The connection dropped.", details: { aiErrorKind: "unavailable" } });
    await tick();
    expect(session(key)!.error!.partial).toBe(true);
    expect(await sendDraft(key)).toBe(false);
  });

  it("the choice to discard goes through the form's own send, with Send Later's time", async () => {
    const { key, c } = await writing();
    const send = vi.fn();
    const stop = registerDraftCommands(key, { send, discard() {}, attach() {}, showCc() {}, showBcc() {}, link() {}, pin() {}, unpin() {}, state: () => ({}) as never });
    const at = Date.now() + 3_600_000;
    await sendDraft(key, at);
    store.discardAndSend(key);
    expect(session(key)).toBeUndefined();
    expect(send).toHaveBeenCalledWith(at);
    expect(calls("ai.cancel")).toHaveLength(1);
    expect(c.text).toBe("");
    stop();
  });

  it("plan 161: a gap the model left stops Send once, inline; Fill it in selects it, Send anyway sends", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("Yes. [What you think.] Thanks.", { checks: { specifics: [], placeholders: ["[What you think.]"] } }));
    await tick();
    // a bracket the user typed is theirs: only the model's gaps count
    c.type(" [sic]");
    expect(store.gapsLeft(key)).toEqual(["[What you think.]"]);
    expect(await sendDraft(key)).toBe(false);
    expect(calls("compose.send")).toHaveLength(0);
    expect(session(key)!.guard).toEqual({ sendAt: undefined, gaps: ["[What you think.]"] });
    store.keepWriting(key);
    expect(session(key)!.guard).toBeNull();
    expect(c.selected).toBe("[What you think.]");
    // filled in: nothing stops it
    c.text = "Yes. I like it. Thanks. [sic]";
    expect(store.gapsLeft(key)).toEqual([]);
    expect(aiDraftHooks.blocksSend(key, undefined)).toBe(false);
    // left in, and sent anyway
    c.text = "Yes. [What you think.] Thanks.";
    const send = vi.fn();
    const stop = registerDraftCommands(key, { send, discard() {}, attach() {}, showCc() {}, showBcc() {}, link() {}, pin() {}, unpin() {}, state: () => ({}) as never });
    expect(aiDraftHooks.blocksSend(key, undefined)).toBe(true);
    store.discardAndSend(key);
    expect(send).toHaveBeenCalledWith(undefined);
    expect(c.text).toBe("Yes. [What you think.] Thanks.");
    stop();
  });

  it("with nothing undecided it sends, with the authored text, once provenance is written", async () => {
    rpc.deferred.add("writing.commitGeneration");
    const { key } = await writing();
    last("ai.compose").resolve(done("Sent as written."));
    await tick();
    await tick();
    const provenance = last("writing.commitGeneration");
    expect(provenance.params).toMatchObject({ accountId: 1, draftId: 42, draftGeneration: "identity", address: "ana@example.test", text: "Sent as written." });
    // (the stand-in editor isn't the draft's body source: the real one's change put this here)
    editDraft(key, { bodyText: "Sent as written." });
    const sending = sendDraft(key);
    await tick();
    await tick();
    expect(calls("compose.send")).toHaveLength(0);
    provenance.resolve({ ok: true });
    await tick();
    expect(await sending).toBe(true);
    expect(last("compose.send").params.authoredText).toBe("Sent as written.");
  });

  it("a send with no AI in the draft carries the authored text too: without it the message counts as the model's", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "by hand" });
    expect(await sendDraft(key)).toBe(true);
    expect(last("compose.send").params.authoredText).toBe("by hand");
  });
});

describe("the subject: §10.3's compound undo", () => {
  const filled = async () => {
    const view = await writing({ mode: "new" });
    expect(last("ai.compose").params.needsSubject).toBe(true);
    last("ai.compose").resolve(done("Body.", { subject: "Generated subject" }));
    await tick();
    expect(useDrafts.getState().drafts[view.key]!.subject).toBe("Generated subject");
    return view;
  };

  it("the strip's Undo takes back both", async () => {
    const { key, c } = await filled();
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    expect(useDrafts.getState().drafts[key]!.subjectEdited).toBe(false);
    // plan 163: the first write taken back leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
  });

  it("neither overwrites a subject edited since", async () => {
    const { key, c } = await filled();
    editDraft(key, { subject: "My own", subjectEdited: true });
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("My own");
  });

  it("ordinary undo is the text's: taking the write back whole ends the strip, and the subject stays", async () => {
    const { key, c } = await filled();
    c.undoGenerated(c.doc);
    store.noteBody(key);
    expect(session(key)).toBeUndefined();
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
  });

  it("plan 161: ⌘Z past a refinement leaves the strip for the version under it", async () => {
    const { key, c } = await filled();
    store.refine(key, "warmer");
    last("ai.compose").resolve(done("Warmer body."));
    await tick();
    c.undoGenerated(c.doc);
    expect(c.text).toBe("Body.");
    expect(session(key)!.strip!.stack).toHaveLength(1);
  });

  it("plan 161: Undo after an edit restores exactly what the write found, subject too, and the snack's Undo brings the edit back", async () => {
    const { key, c } = await filled();
    c.type(" Mine.");
    expect(session(key)!.strip!.edited).toBe(true);
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    // plan 163: the first write taken back, edited or not, leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
    // the draft stays, blank: what was typed is one Undo away
    expect(useDrafts.getState().drafts[key]).toBeDefined();
    const { useSnack, runUndo } = await import("./snack");
    expect(JSON.stringify(useSnack.getState().current)).toContain("Back to before the AI draft");
    await runUndo(useSnack.getState().undo!);
    expect(c.text).toBe("Body. Mine.");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.edited).toBe(true);
  });

  it("Codex review 1: ⌘Z right after an edited Undo brings back the strip, the subject and the gaps' guard with the text", async () => {
    const { key, c } = await writing({ mode: "new" });
    last("ai.compose").resolve(done("On [date].", { subject: "Generated subject", checks: { specifics: [], placeholders: ["[date]"] } }));
    await tick();
    c.type(" Mine.");
    store.undoCommit(key);
    // plan 163: the first write taken back, edited or not, leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    // the editor's own undo of the restore, not the snack's
    c.undoGenerated(c.doc);
    expect(c.text).toBe("On [date]. Mine.");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.edited).toBe(true);
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
    expect(store.gapsLeft(key)).toEqual(["[date]"]);
    expect(aiDraftHooks.blocksSend(key, undefined)).toBe(true);
  });

  it("Codex review, second pass: ⌘⇧Z takes the edited text away again as the Undo left it, and ⌘Z brings it back again", async () => {
    const { key, c } = await writing({ mode: "new" });
    last("ai.compose").resolve(done("On [date].", { subject: "Generated subject", checks: { specifics: [], placeholders: ["[date]"] } }));
    await tick();
    c.type(" Mine.");
    store.undoCommit(key);
    c.undoGenerated(c.doc);
    expect(session(key)!.strip!.edited).toBe(true);
    c.redo();
    expect(c.text).toBe("");
    expect(session(key)).toBeUndefined();
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    c.undoGenerated(c.doc);
    expect(c.text).toBe("On [date]. Mine.");
    expect(session(key)!.strip!.edited).toBe(true);
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
    expect(store.gapsLeft(key)).toEqual(["[date]"]);
  });

  it("Codex review, second pass: a newer run retires the old snack's Undo, even when it's stopped with nothing written", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    c.type(" Mine.");
    store.undoCommit(key);
    const { useSnack, runUndo } = await import("./snack");
    const old = useSnack.getState().undo!;
    await store.openRow({ key });
    await store.submit(key);
    store.stop(key);
    // plan 163: stopped with nothing written, the body is as it was, and no row
    expect(session(key)).toBeUndefined();
    await runUndo(old);
    expect(c.text).toBe("");
    expect(session(key)).toBeUndefined();
  });

  it("Codex review 2: going back to an earlier version brings back its own checks, and its gaps are guarded", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("On [date].", { checks: { specifics: [], placeholders: ["[date]"] } }));
    await tick();
    store.refine(key, "shorter");
    last("ai.compose").resolve(done("Soon."));
    await tick();
    expect(store.gapsLeft(key)).toEqual([]);
    store.undoCommit(key);
    expect(c.text).toBe("On [date].");
    expect(session(key)!.strip!.checks.placeholders).toEqual(["[date]"]);
    expect(store.gapsLeft(key)).toEqual(["[date]"]);
    // the same by the editor's ⌘Z
    store.refine(key, "shorter");
    last("ai.compose").resolve(done("Soon."));
    await tick();
    c.undoGenerated(c.doc);
    expect(c.text).toBe("On [date].");
    expect(session(key)!.strip!.checks.placeholders).toEqual(["[date]"]);
  });

  it("Codex review 3: a refinement stopped on an edited strip leaves that strip, edited", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    c.type(" Mine.");
    store.refine(key, "shorter");
    // plan 161, pass 2: over an edit it asks first
    store.confirmReplace(key);
    expect(session(key)!.phase).toBe("writing");
    store.stop(key);
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.edited).toBe(true);
    // and Discard of a suggestion the same
    store.refine(key, "shorter");
    store.confirmReplace(key);
    store.discard(key);
    expect(session(key)!.phase).toBe("strip");
  });

  it("Codex review 4: an old snack's Undo does nothing once newer work has begun", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    c.type(" Mine.");
    store.undoCommit(key);
    expect(c.text).toBe("");
    const { useSnack, runUndo } = await import("./snack");
    const old = useSnack.getState().undo!;
    await store.openRow({ key });
    await store.submit(key);
    expect(session(key)!.phase).toBe("writing");
    await runUndo(old);
    expect(c.text).toBe("");
    expect(session(key)!.phase).toBe("writing");
  });

  it("Codex review 6: an edit that changes no words (formatting, an image) still gets the snack that brings it back", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    // bold on a word: the same text, another document
    c.doc = { text: c.text, bold: true };
    store.noteBody(key);
    expect(session(key)!.strip!.edited).toBe(true);
    store.undoCommit(key);
    const { useSnack } = await import("./snack");
    expect(JSON.stringify(useSnack.getState().current)).toContain("Back to before the AI draft");
  });

  it("plan 161: edited under a refinement, Undo goes back to the version before it, unedited", async () => {
    const { key, c } = await filled();
    store.refine(key, "warmer");
    last("ai.compose").resolve(done("Warmer body."));
    await tick();
    c.type(" Edit.");
    store.undoCommit(key);
    expect(c.text).toBe("Body.");
    expect(session(key)!.strip!.stack).toHaveLength(1);
    expect(session(key)!.strip!.edited).toBe(false);
    // and that version's own Undo goes back exactly too, never through the restore's step
    store.undoCommit(key);
    expect(c.text).toBe("");
    // plan 163: the first write taken back, edited or not, leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
  });

  it("a subject the user wrote before is never touched", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test", subject: "Mine" });
    const { c } = editor(key);
    await store.openRow({ key });
    await store.submit(key);
    await tick();
    expect(last("ai.compose").params.needsSubject).toBe(false);
    last("ai.compose").resolve(done("Body.", { subject: "Not this" }));
    await tick();
    expect(c.text).toBe("Body.");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Mine");
  });

  it("under a refinement Undo goes back one version, and the strip stays for the one before", async () => {
    const { key, c } = await filled();
    store.refine(key, "warmer");
    last("ai.compose").resolve(done("Warmer body."));
    await tick();
    expect(c.text).toBe("Warmer body.");
    store.undoCommit(key);
    expect(c.text).toBe("Body.");
    expect(session(key)!.phase).toBe("strip");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
  });
});

describe("existing text, and what goes wrong", () => {
  it("text in the body is notes: sent as such, ending in a choice; it never replaces on its own", async () => {
    const { key, c } = await writing({ body: "fine with the 19th" });
    expect(last("ai.compose").params.draft).toBe("fine with the 19th");
    expect(store.previewMode(session(key))).toBe("below");
    last("ai.compose").resolve(done("Full draft."));
    await tick();
    expect(session(key)!.choice!.reason).toBe("notes");
    expect(c.text).toBe("fine with the 19th");
    store.place(key, "replace");
    expect(c.text).toBe("Full draft.");
    store.undoCommit(key);
    expect(c.text).toBe("fine with the 19th");
  });

  it("caret on the first placeholder: the commit names it, and every gap to mark", async () => {
    const { c } = await writing();
    last("ai.compose").resolve(done("On [date] at [time].", { checks: { specifics: [], placeholders: ["[date]", "[time]"] } }));
    await tick();
    expect(c.placeholder).toBe("[date]");
    expect(c.gaps).toEqual(["[date]", "[time]"]);
  });

  it("a refusal discards what came, with the plan's words", async () => {
    const { key } = await writing();
    delta(key, "partial");
    last("ai.compose").reject({ code: "AI", message: "x", details: { aiErrorKind: "refused" } });
    await tick();
    expect(session(key)!.error).toMatchObject({ message: "The model declined to write this. You can reword the instruction or write it yourself.", partial: false });
    expect(store.previewText(key)).toBe("");
  });

  it("a connection lost mid-stream keeps the text, with Insert and Try again, and retries nothing by itself", async () => {
    const { key, c } = await writing();
    delta(key, "kept part");
    last("ai.compose").reject({ code: "AI", message: "Dropped", details: { aiErrorKind: "unavailable" } });
    await tick();
    expect(session(key)!.error).toMatchObject({ partial: true, retry: true });
    expect(calls("ai.compose")).toHaveLength(1);
    expect(store.previewText(key)).toBe("kept part");
    store.placePartial(key);
    expect(c.text).toBe("kept part");
    expect(session(key)!.strip!.cutOff).toBe(true);
  });

  it("Try again asks what it asked", async () => {
    const { key } = await writing();
    store.setInstruction(key, "keep this");
    last("ai.compose").reject({ code: "AI", message: "Busy", details: { aiErrorKind: "rate_limited" } });
    await tick();
    store.retry(key);
    expect(calls("ai.compose")).toHaveLength(2);
    expect(calls("ai.compose")[1]!.params.instruction).toBe(calls("ai.compose")[0]!.params.instruction);
  });

  it("not_configured is the no-provider row; a stream cancelled from elsewhere writes nothing", async () => {
    const { key, c } = await writing();
    last("ai.compose").reject({ code: "AI", message: "x", details: { aiErrorKind: "not_configured" } });
    await tick();
    expect(session(key)!.phase).toBe("noProvider");
    store.closeRow(key);
    await store.openRow({ key });
    await store.submit(key);
    last("ai.compose").reject({ code: "CANCELLED", message: "Cancelled." });
    await tick();
    expect(session(key)!.phase).toBe("input");
    expect(c.text).toBe("");
  });

  it("stop: length keeps the text, and says it was cut off", async () => {
    const { key } = await writing();
    last("ai.compose").resolve(done("Long", { stop: "length" }));
    await tick();
    expect(session(key)!.strip!.cutOff).toBe(true);
  });

  it("waitingBody asks again when the text arrives, and says what it's waiting for", async () => {
    const { key } = await writing();
    last("ai.compose").resolve({ status: "waitingBody", messageId: 3 });
    await tick();
    expect(session(key)!.phase).toBe("waitingBody");
    expect(session(key)!.live).toBe("Still downloading this message");
  });

  it("no provider: the row says so, and asks nothing", async () => {
    setApp({ settings: { ai: { provider: "none", model: "", local: true, tasks: {}, keys: {}, hasKey: false, keyConfirmed: false, profiles: {} } } as never });
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    await store.openRow({ key });
    expect(session(key)!.phase).toBe("noProvider");
    expect(rpc.calls.filter((c) => c.method.startsWith("ai."))).toHaveLength(0);
  });

  it("Plan 147: Dev mode's switch off, a strip already up asks nothing, whichever way it's asked, and keeps its Undo", async () => {
    const { key } = await writing();
    const ai = getApp().settings!.ai;
    setApp({ devAi: { anthropic: true, openai: false, jev: false }, settings: { ai, devAi: true } as never });
    delta(key, "Hello");
    last("ai.compose").resolve(done("Hello"));
    await tick();
    expect(session(key)!.phase).toBe("strip");
    const strip = session(key)!.strip;
    const asked = calls("ai.compose").length;

    setApp({ settings: { ai, devAi: false } as never });
    store.refine(key, "shorter");
    expect(session(key)!.phase).toBe("noProvider");
    expect(session(key)!.strip).toBe(strip);
    store.retry(key);
    await tick();
    expect(calls("ai.compose")).toHaveLength(asked);
    setApp({ devAi: null });
  });

  it("a cloud provider's first draft goes at once, with nothing asked first (plan 131: no per-use consent)", async () => {
    setApp({ settings: { ai: { provider: "anthropic", model: "x", local: false, tasks: {}, keys: {}, hasKey: true, keyConfirmed: true, profiles: {} } } as never });
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    await store.submit(key);
    await tick();
    expect(session(key)!.phase).toBe("writing");
    expect(calls("ai.compose")).toHaveLength(1);
  });

  it("plan 163: a summary item's Reply puts its words in an empty body; nothing runs until ⌘J, and never over what's there", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "ana@example.test" });
    const { c } = editor(key);
    await store.openRow({ key, instruction: "Review the document before Friday" });
    // in the editor that's there, at once
    expect(c.text).toBe("Review the document before Friday");
    expect(calls("ai.compose")).toHaveLength(0);
    expect(calls("ai.resolveIntent")).toHaveLength(0);
    const typed = createDraft({ ...newFields(1), mode: "reply", threadId: 8, inReplyToMessageId: 4, toText: "ana@example.test", bodyText: "mine" });
    const other = editor(typed, "mine");
    await store.openRow({ key: typed, instruction: "something else" });
    expect(other.c.text).toBe("mine");
    // no editor yet: in the draft it will open with
    const later = createDraft({ ...newFields(1), mode: "reply", threadId: 9, inReplyToMessageId: 5, toText: "ana@example.test" });
    await store.openRow({ key: later, instruction: "Say thanks" });
    expect(useDrafts.getState().drafts[later]!.bodyText).toBe("Say thanks");
  });
});

describe("§5.2: a sentence's decision", () => {
  const asked = async (decision: unknown, o: { to?: string; fromAccountId?: number | null } = {}) => {
    const key = createDraft({ ...newFields(1), toText: o.to ?? "ana@example.test", ...(o.to === "" ? {} : {}) });
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "tell tom that this is just fine");
    const done = store.submit(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision, fromAccountId: o.fromAccountId ?? null, confirmFailed: false });
    await done;
    await tick();
    return key;
  };
  const tom = { name: "Tom Reed", address: "tom@acme.test" };

  it("a question sends nothing and addresses nobody until it's answered", async () => {
    const key = await asked({ kind: "ask", question: { type: "add-or-just-write", to: tom } });
    expect(session(key)!.phase).toBe("question");
    expect(calls("ai.compose")).toHaveLength(0);
    expect(useDrafts.getState().drafts[key]!.toText).toBe("ana@example.test");
    await store.answer(key, "justWrite");
    expect(useDrafts.getState().drafts[key]!.toText).toBe("ana@example.test");
    expect(calls("ai.compose")).toHaveLength(1);
  });

  it("Add Tom adds, and To is set before any text is asked for", async () => {
    const key = await asked({ kind: "ask", question: { type: "add-or-just-write", to: tom } });
    await store.answer(key, "add");
    expect(useDrafts.getState().drafts[key]!.toText).toContain("tom@acme.test");
    expect(last("ai.compose").params.to).toEqual([{ name: "", email: "ana@example.test" }, { name: "Tom Reed", email: "tom@acme.test" }]);
  });

  it("a new message goes to them, from the account that last wrote to them", async () => {
    const key = await asked({ kind: "route", route: { type: "fill-draft", to: tom } }, { fromAccountId: 2 });
    const d = useDrafts.getState().drafts[key]!;
    expect(d.toText).toContain("tom@acme.test");
    expect(d.accountId).toBe(2);
    expect(last("ai.compose").params.accountId).toBe(2);
  });

  it("nobody, on a draft with nobody on it: it asks who", async () => {
    const key = await asked({ kind: "route", route: { type: "keep-draft" } }, { to: "" });
    expect(session(key)!.phase).toBe("input");
    expect(session(key)!.who).toBe(true);
    expect(session(key)!.instruction).toBe("tell tom that this is just fine");
    expect(calls("ai.compose")).toHaveLength(0);
  });

  it("the confirmation failing says so, and the route stays", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "tell mark");
    const run = store.submit(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: true });
    await run;
    expect(session(key)!.confirmFailed).toBe(true);
    expect(useDrafts.getState().drafts[key]!.toText).toBe("ana@example.test");
  });

  it("the index cold: it says it's looking and asks again with nothing to poll", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "tell tom");
    const run = store.submit(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "wait", tokens: ["tom"] }, fromAccountId: null, confirmFailed: false });
    await tick();
    expect(session(key)!.lookingUp).toBe(true);
    expect(last("ai.resolveIntent").params.waitForContacts).toBe(true);
    last("ai.resolveIntent").resolve({ decision: { kind: "wait", tokens: ["tom"] }, fromAccountId: null, confirmFailed: false });
    await run;
    // still cold: treated as nobody
    expect(calls("ai.compose")).toHaveLength(1);
  });
});

describe("a prepared reply, used (plan 144)", () => {
  const row = (over: Partial<PreparedReply> = {}): PreparedReply => ({ rowId: "r1", threadId: 7, sourceStamp: "s", generationKey: "k", answeringMessageId: 3, state: "used", body: "Hola Ana", used: null, checks: null, to: [{ name: "Ana", email: "ana@example.test" }], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: 1, revision: 1, ...over });
  const fresh = (toText = "Ana <ana@example.test>", body = "") => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText });
    return { key, ...editor(key, body) };
  };
  const back: unknown[] = [];
  store.preparedHooks.back = (p) => back.push(p);
  beforeEach(() => void (back.length = 0));

  it("goes in as one step with no request, and its Undo gives the row back", async () => {
    const { key, c } = fresh();
    expect(store.commitPrepared(key, row(), true)).toBe(true);
    expect(c.text).toBe("Hola Ana");
    expect(rpc.calls.filter((r) => r.method === "ai.compose")).toEqual([]);
    store.undoCommit(key);
    expect(c.text).toBe("");
    await vi.waitFor(() => expect(calls("drafts.delete")).toHaveLength(1));
    last("drafts.delete").resolve({ ok: true });
    await vi.waitFor(() => expect(back).toEqual([{ threadId: 7, rowId: "r1", revision: 1 }]));
  });

  it("over work already there it's only offered; nor is it put in a draft to someone else", () => {
    const typed = fresh(undefined, "My own words");
    expect(store.commitPrepared(typed.key, row(), false)).toBe(false);
    expect(typed.c.text).toBe("My own words");
    expect(session(typed.key)!.phase).toBe("choice");
    const moved = fresh("Bob <bob@example.test>");
    expect(store.commitPrepared(moved.key, row(), false)).toBe(false);
    expect(moved.c.text).toBe("");
    expect(session(moved.key)!.choice?.writtenFor).toBe("Ana");
    store.discard(moved.key);
    expect(back).toEqual([{ threadId: 7, rowId: "r1", revision: 1 }]);
  });

  it("an editor undo gives it back too, even after typing and through a remount, and each draft gives back its own", () => {
    const a = fresh();
    store.commitPrepared(a.key, row(), true);
    const b = fresh();
    store.commitPrepared(b.key, row({ rowId: "r2", revision: 5 }), true);
    a.c.type(" más");
    a.c.text = "";
    a.c.doc = { text: a.c.text };
    store.noteBody(a.key);
    expect(back).toEqual([{ threadId: 7, rowId: "r1", revision: 1 }]);
    // typed in: the draft is theirs
    expect(useDrafts.getState().drafts[a.key]).toBeDefined();
  });

  it("with no editor listening, as after the strip's gone, the draft's own text still brings it back; a draft that goes takes the words", () => {
    const { key, c, unmount } = fresh();
    store.commitPrepared(key, row(), false);
    unmount();
    c.text = "typed";
    editDraft(key, { bodyHtml: "<p>typed</p>", bodyText: "typed" });
    expect(back).toEqual([]);
    c.text = "";
    editDraft(key, { bodyHtml: "", bodyText: "" });
    expect(back).toEqual([{ threadId: 7, rowId: "r1", revision: 1 }]);
    back.length = 0;
    const gone = fresh();
    store.commitPrepared(gone.key, row(), false);
    const { [gone.key]: _dropped, ...rest } = useDrafts.getState().drafts;
    useDrafts.setState({ drafts: rest });
    gone.c.text = "";
    store.noteBody(gone.key);
    expect(back).toEqual([]);
  });
});

describe("what the Codex review found", () => {
  const tomRoute = { decision: { kind: "route", route: { type: "fill-draft", to: { name: "Tom Reed", address: "tom@acme.test" } } }, fromAccountId: 2, confirmFailed: false };

  it("1: To or From changing while the decision is on its way: the old decision is dropped, and it asks again about what's there now", async () => {
    const key = createDraft(newFields(1));
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "tell tom that this is just fine");
    void store.submit(key);
    await tick();
    expect(last("ai.resolveIntent").params.surface).toEqual({ kind: "list" });
    editDraftRecipients(key, "to", "ana@example.test", ["ana@example.test"]);
    last("ai.resolveIntent").resolve(tomRoute);
    await tick();
    expect(useDrafts.getState().drafts[key]!.toText).toBe("ana@example.test");
    expect(useDrafts.getState().drafts[key]!.accountId).toBe(1);
    expect(calls("ai.compose")).toHaveLength(0);
    expect(calls("ai.resolveIntent")).toHaveLength(2);
    expect(last("ai.resolveIntent").params.surface).toEqual({ kind: "draft", recipients: [{ name: "", email: "ana@example.test" }] });
  });

  it("2: a named participant whose message has a Reply-To: to them alone, not the team it names", async () => {
    const threads = await import("~/state/threads");
    const message = { id: 3, accountId: 1, from: { name: "Tom Reed", email: "tom@acme.test" }, to: [{ name: "", email: "me@example.test" }], cc: [], replyTo: [{ name: "Team", email: "team@acme.test" }, { name: "List", email: "list@acme.test" }], isSent: false, bodyText: "Hi", snippet: "Hi", subject: "Contract", date: 1, rfcMessageId: "<3@x>", attachments: [], attachmentState: "complete" };
    vi.mocked(threads.loadThread).mockResolvedValueOnce({ thread: { id: 7, accountId: 1, subject: "Contract" }, messages: [message, { ...message, id: 4, from: { name: "Ana", email: "ana@example.test" }, replyTo: [] }] } as never);
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 4, toText: "ana@example.test" });
    const { addressReply } = await import("./compose");
    expect(await addressReply(key, 7, { name: "Tom Reed", address: "tom@acme.test" })).toBe(true);
    const d = useDrafts.getState().drafts[key]!;
    expect(d.toText).toBe("Tom Reed <tom@acme.test>");
    expect(d.ccText).toBe("");
    expect(d.inReplyToMessageId).toBe(3);
  });

  it("3: an image alone in the body is the user's: it ends in a choice, never replaced by itself, and no empty notes are sent", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    const { c } = editor(key);
    c.empty = () => false;
    await store.openRow({ key });
    await store.submit(key);
    expect(last("ai.compose").params.draft).toBeUndefined();
    expect(store.previewMode(session(key))).toBe("below");
    last("ai.compose").resolve(done("Words."));
    await tick();
    expect(session(key)!.phase).toBe("choice");
    expect(c.text).toBe("");
  });

  it("6: the editor's history evicted: Undo still takes the words back and the subject with them, if they're still what it wrote", async () => {
    const { key, unmount } = await writing({ mode: "new" });
    last("ai.compose").resolve(done("Body.", { subject: "Generated" }));
    await tick();
    unmount();
    const rebuilt = editor(key, "Body.");
    store.undoCommit(key);
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    // plan 163: the first write taken back, edited or not, leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
    rebuilt.unmount();
  });

  it("6, plan 161: and if they aren't, it's an edit: the document goes back exactly, and the snack's Undo brings the edit back", async () => {
    const { key, unmount } = await writing({ mode: "new" });
    last("ai.compose").resolve(done("Body.", { subject: "Generated" }));
    await tick();
    unmount();
    const { c } = editor(key, "Body, and more of mine.");
    editDraft(key, { bodyText: "Body, and more of mine." });
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("");
    // plan 163: the first write taken back, edited or not, leaves the body as it was, and no row
    expect(session(key)).toBeUndefined();
    const { useSnack, runUndo } = await import("./snack");
    await runUndo(useSnack.getState().undo!);
    expect(c.text).toBe("Body, and more of mine.");
  });

  it("7: provenance that failed is tried again before the send, so the model's text doesn't count as the user's", async () => {
    rpc.deferred.add("writing.commitGeneration");
    const { key } = await writing();
    last("ai.compose").resolve(done("Sent."));
    await tick();
    await tick();
    last("writing.commitGeneration").reject(new Error("offline"));
    await tick();
    expect(calls("writing.commitGeneration")).toHaveLength(1);
    rpc.deferred.delete("writing.commitGeneration");
    // (this editor's fake doesn't write the model's text to the store, so Send asks about no message first: plan 158)
    expect(await sendDraft(key)).toBe(false);
    expect(await sendDraft(key)).toBe(true);
    expect(calls("writing.commitGeneration")).toHaveLength(2);
    const order = rpc.calls.map((c) => c.method);
    expect(order.lastIndexOf("writing.commitGeneration")).toBeLessThan(order.indexOf("compose.send"));
  });

  it("8: closing the row while it works out where it goes stops that call too", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "tell tom");
    void store.submit(key);
    await tick();
    const requestId = last("ai.resolveIntent").params.requestId;
    store.closeRow(key);
    expect(last("ai.cancel").params.requestId).toBe(requestId);
    // and the answer, when it comes, does nothing
    last("ai.resolveIntent").resolve(tomRoute);
    await tick();
    expect(useDrafts.getState().drafts[key]!.toText).toBe("ana@example.test");
    expect(calls("ai.compose")).toHaveLength(0);
  });

  it("9: a run starting never takes focus from another draft's editor", async () => {
    const other = document.createElement("div");
    other.dataset.testid = "composer";
    other.dataset.draftKey = "another";
    const otherBody = document.createElement("div");
    otherBody.dataset.testid = "compose-body";
    otherBody.tabIndex = 0;
    other.append(otherBody);
    document.body.append(other);
    otherBody.focus();
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    const { c } = editor(key);
    await store.openRow({ key });
    await store.submit(key);
    expect(session(key)!.phase).toBe("writing");
    expect(c.focused).toBe(0);
    expect(document.activeElement).toBe(otherBody);
    other.remove();
  });

  it("10: the row's control takes focus for a request once: mounting again doesn't take it again", async () => {
    expect(store.takeFocusRequest("k", 0)).toBe(false);
    expect(store.takeFocusRequest("k", 1)).toBe(true);
    expect(store.takeFocusRequest("k", 1)).toBe(false);
    expect(store.takeFocusRequest("k", 2)).toBe(true);
  });
});

describe("the row", () => {
  it("plan 163: ⌘J over an untouched strip is Regenerate; typed in since, it asks first; Esc on the strip is the form's", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    await store.act(key);
    expect(session(key)!.phase).toBe("writing");
    expect(last("ai.compose").params).toMatchObject({ instruction: "" });
    expect(last("ai.compose").params.previousDraft).toBeUndefined();
    last("ai.compose").resolve(done("Second."));
    await tick();
    expect(aiDraftHooks.escape(key)).toBe(false);
    // edited inside the draft (words added after it are a revision: plan 162, after ai162-r04)
    c.text = `Mine. ${c.text}`;
    c.type("");
    await store.act(key);
    expect(session(key)!.confirm).toEqual({ how: "regenerate" });
  });

  it("plan 161: the strip stays after a keystroke, as Edited after AI, until the draft goes", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    c.type("!");
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.strip!.edited).toBe(true);
    expect(calls("ai.composeEnd")).toHaveLength(0);
    forgetDraft(key);
    expect(session(key)).toBeUndefined();
    expect(calls("ai.composeEnd")).toHaveLength(1);
  });

  it("off in Settings: ⌘J does nothing", async () => {
    useAiDraftUi.setState({ enabled: false });
    const { openAiDraft } = await import("./ai-draft");
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    openAiDraft({ key });
    await tick();
    expect(session(key)).toBeUndefined();
    expect(getApp().dialog).toBeNull();
  });
});

describe("plan 161, pass 2: never losing the user's work", () => {
  const written = async (text = "First.") => {
    const view = await writing();
    last("ai.compose").resolve(done(text));
    await tick();
    expect(session(view.key)!.phase).toBe("strip");
    return view;
  };

  it.each(["regenerate", "shorter", "warmer"] as const)("%s over an edited strip asks first; Keep editing runs nothing and leaves the text", async (how) => {
    const { key, c } = await written();
    c.type(" Mine.");
    const before = calls("ai.compose").length;
    store.refine(key, how);
    expect(session(key)!.confirm).toEqual({ how });
    expect(session(key)!.phase).toBe("strip");
    expect(calls("ai.compose")).toHaveLength(before);
    store.keepEdits(key);
    expect(session(key)!.confirm).toBeNull();
    expect(c.text).toBe("First. Mine.");
    expect(calls("ai.compose")).toHaveLength(before);
  });

  it("Replace runs it from the text as it is then, and the strip's Undo brings the edits back exactly", async () => {
    const { key, c } = await written();
    c.type(" Mine.");
    store.refine(key, "shorter");
    c.type(" More.");
    store.confirmReplace(key);
    expect(session(key)!.phase).toBe("writing");
    expect(last("ai.compose").params.previousDraft).toBe("First. Mine. More.");
    last("ai.compose").resolve(done("Short."));
    await tick();
    expect(c.text).toBe("Short.");
    store.undoCommit(key);
    expect(c.text).toBe("First. Mine. More.");
  });

  it("an unedited strip runs at once; Esc on the question is Keep editing", async () => {
    const { key, c } = await written();
    store.refine(key, "regenerate");
    expect(session(key)!.confirm).toBeNull();
    expect(session(key)!.phase).toBe("writing");
    last("ai.compose").resolve(done("Again."));
    await tick();
    c.type(" Mine.");
    store.refine(key, "warmer");
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(session(key)!.confirm).toBeNull();
    expect(session(key)!.phase).toBe("strip");
    expect(c.text).toBe("Again. Mine.");
  });

  it("⌘J's free-form refinement over an edit asks too", async () => {
    const { key, c } = await written();
    c.type(" Mine.");
    await store.openRow({ key });
    store.setInstruction(key, "more formal");
    await store.submit(key);
    expect(session(key)!.confirm).toEqual({ how: "refine", instruction: "more formal" });
    store.confirmReplace(key);
    expect(last("ai.compose").params.instruction).toBe("more formal");
    expect(last("ai.compose").params.previousDraft).toBe("First. Mine.");
  });

  it("Esc on a reply ⌘J opened ends the session and leaves Esc to the form; closing the row takes an empty reply it opened", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Ana <ana@example.test>", subject: "Re: Contract" });
    editor(key);
    await store.openRow({ key });
    store.useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: { ...sessions[key]!, opened: true } } }));
    // plan 163: opened for AI and nothing more: Esc is the form's (it closes an empty reply), and the session goes first
    expect(aiDraftHooks.escape(key)).toBe(false);
    expect(session(key)).toBeUndefined();
    expect(useDrafts.getState().drafts[key]).toBeDefined();
    await store.openRow({ key });
    store.useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: { ...sessions[key]!, opened: true } } }));
    store.closeRow(key);
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
  });
});

describe("plan 161, pass 2: the instruction stays, and can be asked again", () => {
  it("a refinement keeps the strip's instruction; editing it writes the draft again from the new words", async () => {
    const view = await writing();
    const { key } = view;
    // the first draft was asked with no words; ask with some
    store.setInstruction(key, "");
    last("ai.compose").resolve(done("First."));
    await tick();
    // plan 163: the popover's pencil
    store.rewriteFrom(key, "say friday works");
    const asked = last("ai.compose").params;
    expect(asked.instruction).toBe("say friday works");
    expect(asked.previousDraft).toBeUndefined();
    last("ai.compose").resolve(done("Friday works."));
    await tick();
    expect(session(key)!.strip!.instruction).toBe("say friday works");
    // Shorter rewrites the text, not what was asked
    store.refine(key, "shorter");
    last("ai.compose").resolve(done("Friday."));
    await tick();
    expect(session(key)!.strip!.instruction).toBe("say friday works");
    store.refine(key, "regenerate");
    expect(last("ai.compose").params.instruction).toBe("say friday works");
  });

  it("Undo of a rewrite brings back the earlier version's instruction, so Regenerate asks what that version was asked", async () => {
    const { key } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    store.rewriteFrom(key, "say saturday");
    last("ai.compose").resolve(done("Saturday."));
    await tick();
    expect(session(key)!.strip!.instruction).toBe("say saturday");
    store.undoCommit(key);
    expect(session(key)!.strip!.instruction).toBe("");
    store.refine(key, "regenerate");
    expect(last("ai.compose").params.instruction).toBe("");
  });

  it("plan 163: opening the draft for AI again over a strip keeps the strip and its Undo", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    await store.openRow({ key });
    expect(session(key)!.phase).toBe("strip");
    store.undoCommit(key);
    expect(c.text).toBe("");
  });
});

describe("plan 161, pass 2: a prepared reply, discarded", () => {
  const row = (): PreparedReply => ({ rowId: "r9", threadId: 7, sourceStamp: "s", generationKey: "k", answeringMessageId: 3, state: "used", body: "Hola Ana", used: null, checks: null, to: [{ name: "Ana", email: "ana@example.test" }], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: 1, revision: 4 });
  const back: unknown[] = [];
  beforeEach(() => {
    back.length = 0;
    store.preparedHooks.back = (p) => back.push(p);
  });

  it("its Discard gives the reply back, typed in or not", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Ana <ana@example.test>" });
    const { c } = editor(key);
    store.commitPrepared(key, row(), true);
    c.type(" y más");
    editDraft(key, { bodyHtml: "<p>Hola Ana y más</p>", bodyText: "Hola Ana y más" });
    const gone = drafts.discardDraft(key);
    await vi.waitFor(() => expect(back).toEqual([{ threadId: 7, rowId: "r9", revision: 4 }]));
    await vi.waitFor(() => expect(calls("drafts.delete").length).toBeGreaterThan(0));
    last("drafts.delete").resolve({ ok: true });
    await gone;
  });

  it("a send gives nothing back", async () => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Ana <ana@example.test>", subject: "Re: x" });
    editor(key);
    store.commitPrepared(key, row(), true);
    editDraft(key, { bodyHtml: "<p>Hola Ana</p>", bodyText: "Hola Ana" });
    await sendDraft(key);
    await tick();
    expect(back).toEqual([]);
  });
});

describe("plan 161, pass 2: what the Codex review found", () => {
  it("1: Try again after a failed rewrite, over text typed since, asks first too", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    store.refine(key, "regenerate");
    last("ai.compose").reject({ code: "AI", message: "x", details: { aiErrorKind: "timeout" } });
    await tick();
    expect(session(key)!.phase).toBe("error");
    c.type(" Mine.");
    const before = calls("ai.compose").length;
    store.retry(key);
    expect(session(key)!.confirm).toMatchObject({ how: "retry" });
    expect(calls("ai.compose")).toHaveLength(before);
    store.keepEdits(key);
    expect(c.text).toBe("First. Mine.");
  });

  it("1 (second pass): a rewrite that failed part-way, then typed in: Try again asks first too", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    store.refine(key, "regenerate");
    delta(key, "Fir");
    last("ai.compose").reject({ code: "AI", message: "x", details: { aiErrorKind: "unavailable" } });
    await tick();
    expect(session(key)!.error!.partial).toBe(true);
    c.type(" Mine.");
    const before = calls("ai.compose").length;
    store.retry(key);
    expect(session(key)!.confirm).toMatchObject({ how: "retry" });
    expect(session(key)!.phase).toBe("strip");
    expect(calls("ai.compose")).toHaveLength(before);
    store.confirmReplace(key);
    expect(calls("ai.compose")).toHaveLength(before + 1);
    last("ai.compose").resolve(done("Again."));
    await tick();
    expect(c.text).toBe("Again.");
    store.undoCommit(key);
    expect(c.text).toBe("First. Mine.");
  });

  it("7: a screen reader hears the error as shown, never the provider's address", async () => {
    const { key } = await writing();
    last("ai.compose").reject({ code: "AI", message: "Couldn’t find Ollama at 127.0.0.1:60512. Is it open?", details: { aiErrorKind: "unavailable" } });
    await tick();
    expect(session(key)!.live).not.toMatch(/127\.0\.0\.1|60512/);
    expect(session(key)!.live).toMatch(/^Couldn’t reach /);
  });
});

describe("plan 162 (after ai162-r02): what made a version, for Undo's name", () => {
  it("tells Regenerate from an edited instruction's fresh take, and the rewrites apart", async () => {
    const { commitHow, SHORTER, WARMER } = await import("./ai-draft");
    expect(commitHow({ kind: "draft", instruction: "x" })).toBe("draft");
    expect(commitHow({ kind: "refine", instruction: "x", regenerate: true })).toBe("regenerate");
    expect(commitHow({ kind: "refine", instruction: "y", regenerate: true, edited: true })).toBe("rewrite");
    expect(commitHow({ kind: "refine", instruction: SHORTER })).toBe("shorter");
    expect(commitHow({ kind: "refine", instruction: WARMER })).toBe("warmer");
    expect(commitHow({ kind: "refine", instruction: "make it formal" })).toBe("rewrite");
  });
});

describe("plan 163: ⌘J on what's written in the body", () => {
  const reply = (body: string, o: { to?: string } = {}) => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: o.to ?? "Arjun Ramírez <arjun@example.test>", subject: "Re: The flat", bodyText: body });
    return { key, ...editor(key, body) };
  };
  const keepDraft = { decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false };
  const fill = (key: string, gap: number, text: string, done: boolean) => rpc.events.get("aiFill")!({ requestId: session(key)!.run!.requestId, gap, text, done });

  it("an instruction is written from, and the draft replaces it in one step; Undo puts the instruction back exactly, with no row", async () => {
    const { key, c } = reply("friday works for me, ask him to send the address of the flat");
    void store.act(key);
    await tick();
    // who it's for is still worked out, from the conversation: the reply's recipients are Terno's, though the body was typed in
    expect(last("ai.resolveIntent").params.surface).toEqual({ kind: "thread", threadId: 7 });
    last("ai.resolveIntent").resolve(keepDraft);
    await tick();
    expect(session(key)!.run!.spec.kind).toBe("body");
    expect(last("ai.compose").params).toMatchObject({ instruction: "friday works for me, ask him to send the address of the flat" });
    expect(last("ai.compose").params.draft).toBeUndefined();
    // the instruction dims, then the stream takes its place
    expect(store.previewMode(session(key))).toBe("replacing");
    last("ai.compose").resolve(done("Hi Arjun,\n\nFriday works for me. Could you send me the address of the flat?\n\nLuis"));
    await tick();
    expect(c.text).toBe("Hi Arjun,\n\nFriday works for me. Could you send me the address of the flat?\n\nLuis");
    expect(session(key)!.strip!.instruction).toBe("friday works for me, ask him to send the address of the flat");
    store.undoCommit(key);
    expect(c.text).toBe("friday works for me, ask him to send the address of the flat");
    expect(session(key)).toBeUndefined();
  });

  it("typed into while it writes, the draft is offered beside it with Replace, never put over it", async () => {
    const { key, c } = reply("tell him friday works");
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve(keepDraft);
    await tick();
    c.type(" and saturday");
    last("ai.compose").resolve(done("Friday works."));
    await tick();
    expect(session(key)!.phase).toBe("choice");
    expect(session(key)!.choice!.reason).toBe("typed");
    expect(c.text).toBe("tell him friday works and saturday");
  });

  it("their email with gaps: only the gaps are filled, as each comes, in one step; Undo gives every placeholder back", async () => {
    const body = "Hi Arjun, the flat's address is [address from his last mail], see you [day we agreed]";
    const { key, c } = reply(body);
    await store.act(key);
    expect(calls("ai.resolveIntent")).toHaveLength(0);
    const asked = last("ai.compose").params as { fill: { text: string; gaps: { from: number; to: number }[] }; instruction: string };
    expect(asked.instruction).toBe("");
    expect(asked.fill.gaps.map((g) => asked.fill.text.slice(g.from, g.to))).toEqual(["[address from his last mail]", "[day we agreed]"]);
    expect(store.previewMode(session(key))).toBeNull();
    fill(key, 1, "Calle Du", false);
    fill(key, 1, "Calle Durango 123", true);
    expect(c.fill!.streamed.get(1)).toEqual({ text: "Calle Durango 123", done: true });
    // nothing in the document yet
    expect(c.text).toBe(body);
    last("ai.compose").resolve(done("", { fills: ["Calle Durango 123", "Friday"] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, the flat's address is Calle Durango 123, see you Friday");
    expect(session(key)!.strip!.fill).toEqual({ words: ["[address from his last mail]", "[day we agreed]"], fills: ["Calle Durango 123", "Friday"] });
    store.undoCommit(key);
    expect(c.text).toBe(body);
    expect(session(key)).toBeUndefined();
  });

  it("a gap the conversation doesn't answer stays as typed and Send asks about it; nothing answered, nothing changes", async () => {
    const { key, c } = reply("Hi Arjun, see you [day] at [place]");
    await store.act(key);
    last("ai.compose").resolve(done("", { fills: ["Friday", ""] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, see you Friday at [place]");
    expect(store.gapsLeft(key)).toEqual(["[place]"]);
    expect(aiDraftHooks.blocksSend(key, undefined)).toBe(true);
    const other = reply("Hi Arjun, see you [day]");
    await store.act(other.key);
    last("ai.compose").resolve(done("", { fills: [""] }));
    await tick();
    expect(other.c.text).toBe("Hi Arjun, see you [day]");
    expect(session(other.key)!.phase).toBe("error");
    expect(session(other.key)!.strip).toBeNull();
  });

  it("stopped part-way, the fills that finished go in and the rest stay as typed", async () => {
    const { key, c } = reply("Hi Arjun, see you [day] at [place]");
    await store.act(key);
    fill(key, 1, "Friday", true);
    fill(key, 2, "the fl", false);
    store.stop(key);
    expect(c.text).toBe("Hi Arjun, see you Friday at [place]");
    expect(session(key)!.strip!.stopped).toBe(true);
  });

  it("Fill again asks from the text as it was before the first fill, and puts it back filled anew in one step", async () => {
    const body = "Hi Arjun, see you [day]";
    const { key, c } = reply(body);
    await store.act(key);
    last("ai.compose").resolve(done("", { fills: ["Friday"] }));
    await tick();
    store.refine(key, "regenerate");
    const asked = last("ai.compose").params as { fill: { text: string; gaps: { from: number; to: number }[] } };
    expect(asked.fill.text).toBe(body);
    expect(asked.fill.gaps.map((g) => asked.fill.text.slice(g.from, g.to))).toEqual(["[day]"]);
    expect(store.previewMode(session(key))).toBe("rewriting");
    last("ai.compose").resolve(done("", { fills: ["Saturday"] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, see you Saturday");
    // Shorter and Warmer would rewrite their words: they do nothing on a fill
    store.refine(key, "shorter");
    expect(session(key)!.phase).toBe("strip");
    store.undoCommit(key);
    expect(c.text).toBe("Hi Arjun, see you Friday");
    store.undoCommit(key);
    expect(c.text).toBe(body);
  });

  // the owner's answers (2026-11-08): text the rules can't call an instruction or an email starts writing at once
  const UNSURE = "I'm happy to go ahead with the contract as it is. Nothing in it changes what we agreed, so the 19th is fine.";

  it("unsure: writing starts at once, beside the text, with the fast read asked alongside about only what was typed", async () => {
    const { key, c } = reply(UNSURE);
    void store.act(key);
    await tick();
    expect(session(key)!.phase).toBe("writing");
    // asked as what they want to say: right for an instruction, still their words for an email
    expect(last("ai.compose").params).toMatchObject({ instruction: UNSURE });
    expect(last("ai.compose").params.draft).toBeUndefined();
    expect(last("ai.readDraft").params).toEqual({ requestId: expect.any(String), text: UNSURE, maybe: [] });
    // nobody asked who it's for: it's their words, kept where they are
    expect(calls("ai.resolveIntent")).toHaveLength(0);
    expect(store.previewMode(session(key))).toBe("below");
    expect(c.text).toBe(UNSURE);
  });

  it("the read says instruction before the answer: the stream takes the text's place, and the answer replaces it in one step", async () => {
    const { key, c } = reply(UNSURE);
    void store.act(key);
    await tick();
    last("ai.readDraft").resolve({ kind: "instruction", gaps: [] });
    await tick();
    expect(store.previewMode(session(key))).toBe("replacing");
    // still nothing over their words until the answer is whole
    expect(c.text).toBe(UNSURE);
    last("ai.compose").resolve(done("Hi Arjun,\n\nThe 19th is fine.\n\nLuis"));
    await tick();
    expect(c.text).toBe("Hi Arjun,\n\nThe 19th is fine.\n\nLuis");
    expect(session(key)!.strip!.instruction).toBe(UNSURE);
    store.undoCommit(key);
    expect(c.text).toBe(UNSURE);
  });

  it("plan 162 (after ai162-r05, Codex review): opened for AI, words the rules can't place, written then undone: a note again, not a plain draft", async () => {
    const { key, c } = reply(UNSURE);
    setGlance(key, "unsure");
    void store.act(key);
    await tick();
    // ⌘J opened this composer for AI: what's typed then is a note even when the rules are unsure
    store.useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: { ...session(key)!, opened: true } } }));
    last("ai.readDraft").resolve({ kind: "instruction", gaps: [] });
    await tick();
    last("ai.compose").resolve(done("Hi Arjun,\n\nThe 19th is fine.\n\nLuis"));
    await tick();
    store.undoCommit(key);
    expect(c.text).toBe(UNSURE);
    expect(useAiDraftUi.getState().rows[key]).toBe("primed");
    expect(noteState(useAiDraftUi.getState().rows[key], useAiDraftUi.getState().glances[key])).toBe(true);
  });

  it("the answer comes before the read: it waits in view, over nothing, and the read decides where it lands", async () => {
    const a = reply(UNSURE);
    void store.act(a.key);
    await tick();
    const readA = last("ai.readDraft");
    last("ai.compose").resolve(done("A fuller version."));
    await tick();
    expect(session(a.key)!.phase).toBe("writing");
    expect(a.c.text).toBe(UNSURE);
    readA.resolve({ kind: "email", gaps: [] });
    await tick();
    expect(session(a.key)!.phase).toBe("choice");
    expect(session(a.key)!.choice!.reason).toBe("notes");
    expect(a.c.text).toBe(UNSURE);

    const b = reply(UNSURE);
    void store.act(b.key);
    await tick();
    const readB = last("ai.readDraft");
    last("ai.compose").resolve(done("Hi Arjun, the 19th is fine."));
    await tick();
    expect(b.c.text).toBe(UNSURE);
    readB.resolve({ kind: "instruction", gaps: [] });
    await tick();
    expect(b.c.text).toBe("Hi Arjun, the 19th is fine.");
    expect(session(b.key)!.phase).toBe("strip");
  });

  it("the read failing, or typed into meanwhile, leaves it beside with Replace, never over their words", async () => {
    const a = reply(UNSURE);
    void store.act(a.key);
    await tick();
    last("ai.readDraft").reject(new Error("down"));
    await tick();
    last("ai.compose").resolve(done("A fuller version."));
    await tick();
    expect(session(a.key)!.phase).toBe("choice");
    expect(a.c.text).toBe(UNSURE);
    store.place(a.key, "replace");
    expect(session(a.key)!.strip!.readFailed).toBe(true);

    const b = reply(UNSURE);
    void store.act(b.key);
    await tick();
    b.c.type(" Thanks!");
    last("ai.readDraft").resolve({ kind: "instruction", gaps: [] });
    await tick();
    last("ai.compose").resolve(done("Hi Arjun, the 19th is fine."));
    await tick();
    expect(session(b.key)!.phase).toBe("choice");
    expect(b.c.text).toBe(`${UNSURE} Thanks!`);
  });

  it("a read that confirms a gap in their email stops the draft beside it and fills only the gap", async () => {
    const text = "I'm happy to go ahead with the contract as it is. Nothing in it changes what we agreed, so the 19th at ?? is fine.";
    const { key } = reply(text);
    void store.act(key);
    await tick();
    const speculative = last("ai.compose").params.requestId;
    expect(last("ai.readDraft").params.maybe).toHaveLength(1);
    last("ai.readDraft").resolve({ kind: "email", gaps: [0] });
    await tick();
    expect(calls("ai.cancel").map((c) => (c.params as { requestId: string }).requestId)).toContain(speculative);
    const asked = last("ai.compose").params as { fill: { text: string; gaps: { from: number; to: number }[] } };
    expect(asked.fill.gaps.map((g) => asked.fill.text.slice(g.from, g.to))).toEqual(["??"]);
  });

  it("Send while it reads, works out who it's for, or asks, stops: it would mail the instruction (Codex review 6)", async () => {
    const { key } = reply("tell him friday works");
    void store.act(key);
    await tick();
    expect(session(key)!.phase).toBe("resolving");
    expect(await sendDraft(key)).toBe(false);
    expect(calls("compose.send")).toHaveLength(0);
    expect(session(key)!.guard).toEqual({ sendAt: undefined });
    // plan 162 (after ai162-r05, Codex review): what's left is the instruction: it isn't mailed from here, its own
    // question asks ("This reads as a note for AI."), and only Send as it is there sends it
    const { useEmptySend } = await import("./send-problem");
    store.discardAndSend(key);
    await tick();
    expect(calls("compose.send")).toHaveLength(0);
    expect(useEmptySend.getState()).toMatchObject({ key, reason: "note" });
    useEmptySend.setState({ key: null, reason: undefined });
  });

  it("a reply whose recipients someone chose is a draft surface, even from the body (Codex review 3)", async () => {
    const { key } = reply("tell tom it's fine");
    editDraftRecipients(key, "to", "Bea <bea@example.test>", []);
    void store.act(key);
    await tick();
    expect(last("ai.resolveIntent").params.surface).toMatchObject({ kind: "draft" });
  });

  it("over a strip typed in since, gaps they marked are filled on top of it; the model's own gaps are left for them", async () => {
    const { key, c } = reply("");
    await store.act(key);
    last("ai.compose").resolve(done("Hi Arjun, [Your answer.]", { checks: { specifics: [], placeholders: ["[Your answer.]"] } }));
    await tick();
    c.type(" See you [day].");
    await store.act(key);
    const asked = last("ai.compose").params as { fill: { text: string; gaps: { from: number; to: number }[] } };
    expect(asked.fill.gaps.map((g) => asked.fill.text.slice(g.from, g.to))).toEqual(["[day]"]);
    last("ai.compose").resolve(done("", { fills: ["Friday"] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, [Your answer.] See you Friday.");
    expect(session(key)!.strip!.stack).toHaveLength(2);
    store.undoCommit(key);
    expect(c.text).toBe("Hi Arjun, [Your answer.] See you [day].");
  });
});

describe("plan 163: what the Codex review of the code found", () => {
  const reply = (body: string, o: { to?: string } = {}) => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: o.to ?? "Arjun Ramírez <arjun@example.test>", subject: "Re: The flat", bodyText: body });
    return { key, ...editor(key, body) };
  };
  const keepDraft = { decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false };

  // the owner's answers (2026-11-08): what the Codex review of writing at once on unsure text found
  const UNSURE_TEXT = "I'm happy to go ahead with the contract as it is. Nothing in it changes what we agreed, so the 19th is fine.";
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  it("answers 1: Stop on a whole answer waiting for the read puts it in as it came, its gaps still marked, below their words", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    last("ai.compose").resolve(done("See you on [date].", { checks: { specifics: [], placeholders: ["[date]"] } }));
    await tick();
    store.stop(key);
    expect(c.text).toBe(`${UNSURE_TEXT}\n\nSee you on [date].`);
    expect(session(key)!.strip!.checks.placeholders).toEqual(["[date]"]);
    expect(session(key)!.strip!.stopped).toBeUndefined();
  });

  it("answers 2: typed into while it wrote beside unsure text, the choice still offers Replace", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    c.type(" Thanks!");
    last("ai.readDraft").resolve({ kind: "email", gaps: [] });
    last("ai.compose").resolve(done("A fuller version."));
    await tick();
    expect(session(key)!.choice!.reason).toBe("typed");
    expect(store.offersReplace(session(key)!)).toBe(true);
  });

  it("answers 3: a run started again once the message's text arrives keeps the read, and its verdict decides where it lands", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    const read = last("ai.readDraft");
    last("ai.compose").resolve({ status: "waitingBody", messageId: 3 });
    await tick();
    expect(session(key)!.phase).toBe("waitingBody");
    for (const l of threads.listeners) l({ details: new Map([[7, { messages: [{ id: 3, bodyState: "full" }] }]]) });
    await tick();
    expect(session(key)!.phase).toBe("writing");
    read.resolve({ kind: "instruction", gaps: [] });
    await tick();
    last("ai.compose").resolve(done("Hi Arjun, the 19th is fine."));
    await tick();
    expect(c.text).toBe("Hi Arjun, the 19th is fine.");
  });

  it("answers 5: a read that answered while the message's text downloaded decides for the run started after it", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    const read = last("ai.readDraft");
    last("ai.compose").resolve({ status: "waitingBody", messageId: 3 });
    await tick();
    read.resolve({ kind: "instruction", gaps: [] });
    await tick();
    for (const l of threads.listeners) l({ details: new Map([[7, { messages: [{ id: 3, bodyState: "full" }] }]]) });
    await tick();
    last("ai.compose").resolve(done("Hi Arjun, the 19th is fine."));
    await tick();
    expect(c.text).toBe("Hi Arjun, the 19th is fine.");
  });

  it("answers 6: words typed while the message's text downloaded are never replaced on the strength of the earlier read", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    last("ai.readDraft").resolve({ kind: "instruction", gaps: [] });
    await tick();
    last("ai.compose").resolve({ status: "waitingBody", messageId: 3 });
    await tick();
    c.type(" Thanks!");
    for (const l of threads.listeners) l({ details: new Map([[7, { messages: [{ id: 3, bodyState: "full" }] }]]) });
    await tick();
    last("ai.compose").resolve(done("Hi Arjun, the 19th is fine."));
    await tick();
    expect(c.text).toBe(`${UNSURE_TEXT} Thanks!`);
    expect(session(key)!.phase).toBe("choice");
  });

  it("answers 4: stopped after the read called it an instruction, what came takes its place, never beside it", async () => {
    const { key, c } = reply(UNSURE_TEXT);
    void store.act(key);
    await tick();
    last("ai.readDraft").resolve({ kind: "instruction", gaps: [] });
    await tick();
    delta(key, "Hi Arjun, the 19th");
    await frame();
    store.stop(key);
    expect(c.text).toBe("Hi Arjun, the 19th");
    expect(session(key)!.strip!.instruction).toBe(UNSURE_TEXT);
  });

  it("4: a first fill that waited for a message's text reads the body again, where its gaps are now", async () => {
    const { key, c } = reply("Hi Arjun, see you [day]");
    await store.act(key);
    last("ai.compose").resolve({ status: "waitingBody", messageId: 3 });
    await tick();
    expect(session(key)!.phase).toBe("waitingBody");
    c.type("");
    c.text = `Well. ${c.text}`;
    c.doc = { text: c.text };
    for (const l of threads.listeners) l({ details: new Map([[7, { messages: [{ id: 3, bodyState: "full" }] }]]) });
    await tick();
    const asked = last("ai.compose").params as { fill: { text: string; gaps: { from: number; to: number }[] } };
    expect(asked.fill.text).toBe("Well. Hi Arjun, see you [day]");
    expect(asked.fill.gaps.map((g) => asked.fill.text.slice(g.from, g.to))).toEqual(["[day]"]);
  });

  it("5: stopped after the instruction was typed over, what came goes below the new words, never over them", async () => {
    const { key, c } = reply("tell him friday works");
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve(keepDraft);
    await tick();
    rpc.events.get("aiCompose")!({ requestId: session(key)!.run!.requestId, text: "Hi Arjun" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    c.type(" — no, mine");
    store.stop(key);
    expect(c.text).toBe("tell him friday works — no, mine\n\nHi Arjun");
  });

  it("6: Fill again with typing meanwhile changes nothing, and says so", async () => {
    const { key, c } = reply("Hi Arjun, see you [day]");
    await store.act(key);
    last("ai.compose").resolve(done("", { fills: ["Friday"] }));
    await tick();
    store.refine(key, "regenerate");
    c.type(" More of mine.");
    last("ai.compose").resolve(done("", { fills: ["Saturday"] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, see you Friday More of mine.");
    expect(session(key)!.phase).toBe("error");
  });

  it("7: the body rewritten while a question waits: the answer starts over on the new words, not the old instruction", async () => {
    const { key, c } = reply("tell tom it's fine", { to: "Bea <bea@example.test>" });
    editDraftRecipients(key, "to", "Bea <bea@example.test>", ["bea@example.test"]);
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "ask", question: { type: "add-or-just-write", to: { name: "Tom", address: "tom@example.test" } } }, fromAccountId: null, confirmFailed: false });
    await tick();
    expect(session(key)!.phase).toBe("question");
    c.text = "Hi Bea,\n\nAll good here.";
    c.doc = { text: c.text };
    await store.answer(key, "justWrite");
    await tick();
    expect(calls("ai.compose")).toHaveLength(1);
    expect(last("ai.compose").params.instruction).toBe("");
    expect(last("ai.compose").params.draft).toBe("Hi Bea,\n\nAll good here.");
  });

  it("9: an instruction in a list (its bullet only in the serialized email) is written, not routed again forever", async () => {
    const { key, c } = reply("tell him friday works");
    c.snapshot = () => ({ html: "", text: `• ${c.text}` });
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve(keepDraft);
    await tick();
    expect(calls("ai.resolveIntent")).toHaveLength(1);
    expect(session(key)!.phase).toBe("writing");
  });

  it("11: Fill again with nothing it can use leaves the earlier fills where they are", async () => {
    const { key, c } = reply("Hi Arjun, see you [day]");
    await store.act(key);
    last("ai.compose").resolve(done("", { fills: ["Friday"] }));
    await tick();
    store.refine(key, "regenerate");
    last("ai.compose").resolve(done("", { fills: [null] }));
    await tick();
    expect(c.text).toBe("Hi Arjun, see you Friday");
    expect(session(key)!.strip!.fill!.fills).toEqual(["Friday"]);
  });
});

describe("plan 162 (after ai162-r04): revising a draft, and a note for AI", () => {
  const reply = (body: string) => {
    const key = createDraft({ ...newFields(1), mode: "reply", threadId: 7, inReplyToMessageId: 3, toText: "Arjun Ramírez <arjun@example.test>", subject: "Re: The flat", bodyText: body });
    return { key, ...editor(key, body) };
  };
  const draft = "Hey Arjun!\n\nFriday works for me. Could you send me the address of the flat?\n\nCheers,\nLuis";

  it("words typed after the AI's draft are how to change it: rewritten from them, replacing the draft; Undo gives both back exactly", async () => {
    const { key, c } = reply("");
    await store.act(key);
    last("ai.compose").resolve(done(draft));
    await tick();
    expect(c.text).toBe(draft);
    // the rater's case: typed straight after the sign-off, no space
    c.type("shorter, more casual");
    await store.act(key);
    // no "Replace your edits?": the only edit was the instruction
    expect(session(key)!.confirm ?? null).toBeNull();
    expect(last("ai.compose").params).toMatchObject({ instruction: "shorter, more casual", previousDraft: draft });
    last("ai.compose").resolve(done("Friday's good! Send me the flat's address?\n\nLuis"));
    await tick();
    expect(c.text).toBe("Friday's good! Send me the flat's address?\n\nLuis");
    expect(session(key)!.phase).toBe("strip");
    store.undoCommit(key);
    expect(c.text).toBe(`${draft}shorter, more casual`);
  });

  it("a new last paragraph is a revision too; an edit inside the draft isn't (it asks before writing again)", async () => {
    expect(store.revisionOf(draft, `${draft}\n\nmake it warmer`)).toBe("make it warmer");
    expect(store.revisionOf(draft, draft)).toBeNull();
    expect(store.revisionOf(draft, draft.replace("Friday", "Saturday") + " shorter")).toBeNull();
    expect(store.revisionOf(draft, `${draft} ${"x".repeat(1001)}`)).toBeNull();
    const { key, c } = reply("");
    await store.act(key);
    last("ai.compose").resolve(done(draft));
    await tick();
    c.text = c.text.replace("Friday", "Saturday");
    c.type("");
    await store.act(key);
    expect(session(key)!.confirm).toMatchObject({ how: "regenerate" });
  });

  it("an answer that says what the body already says is never offered beside it: the strip says so", async () => {
    const { key, c } = reply("");
    await store.act(key);
    last("ai.compose").resolve(done(draft));
    await tick();
    store.refine(key, "shorter");
    // the same words back (here, but a typed-into rewrite's suggestion too): nothing to put in or beside
    last("ai.compose").resolve(done(`${draft}\n`));
    await tick();
    expect(session(key)!.phase).toBe("strip");
    expect(session(key)!.choice).toBeNull();
    expect(session(key)!.sameNote).toBe(true);
    expect(session(key)!.strip!.stack).toHaveLength(1);
    // the next edit retires the note
    c.type("!");
    expect(session(key)!.sameNote).toBe(false);
  });

  it("Codex review: an instruction pasted and sent at once asks first: Send reads the body, not the glance behind it", async () => {
    const { useEmptySend } = await import("./send-problem");
    const { key } = reply("ask him to send the address of the flat");
    // nothing has published a glance yet (the body's glance follows typing by up to 150 ms)
    expect(useAiDraftUi.getState().glances[key]).toBeUndefined();
    expect(await sendDraft(key)).toBe(false);
    expect(useEmptySend.getState()).toMatchObject({ key, reason: "note" });
    expect(calls("send.send")).toHaveLength(0);
    // the answer to the question sends it as it is
    useEmptySend.setState({ key: null, reason: undefined });
    const plain = reply("Hi Arjun, Friday works for me. See you then.");
    await sendDraft(plain.key);
    expect(useEmptySend.getState().reason).not.toBe("note");
  });

  it("plan 162 (after ai162-r05): Undo of a write from a note gives the note back at once, Write it and all, not 150 ms later", async () => {
    const { key, c } = reply("ask him to send the address of the flat");
    // the body's glance, as the slot publishes it while typing: a note for AI
    setGlance(key, "write");
    expect(noteState(useAiDraftUi.getState().rows[key], useAiDraftUi.getState().glances[key])).toBe(true);
    void store.act(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false });
    await tick();
    last("ai.compose").resolve(done(draft));
    await tick();
    expect(session(key)!.phase).toBe("strip");
    // the draft landed, and typing's throttled glance said so: an email
    setGlance(key, "");
    store.undoCommit(key);
    expect(c.text).toBe("ask him to send the address of the flat");
    // the same moment, not after the next glance: no frame of Send as the primary under the instruction
    expect(noteState(useAiDraftUi.getState().rows[key], useAiDraftUi.getState().glances[key])).toBe(true);
  });

  it("a rewrite typed over while it ran offers Replace, not only Insert below", async () => {
    const { key, c } = reply("");
    await store.act(key);
    last("ai.compose").resolve(done(draft));
    await tick();
    store.refine(key, "shorter");
    c.type(" PS");
    last("ai.compose").resolve(done("Friday works. Address?"));
    await tick();
    expect(session(key)!.phase).toBe("choice");
    expect(store.offersReplace(session(key)!)).toBe(true);
  });
});
