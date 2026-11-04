// @vitest-environment jsdom
/**
 * Plan 133 §10.4: each race, on the real draft store and a stand-in for the editor. What the editor itself does with
 * the text is in composer/generated.test.ts; the whole of it, in a page, in e2e/ai-draft.spec.ts.
 */
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
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn(async () => null), useThreads: { subscribe: () => () => {} } }));

const store = await import("./ai-draft");
const { aiDraftHooks, useAiDraftUi } = await import("./ai-draft-state");
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
  const listeners = new Set<() => void>();
  const c = {
    text: initial,
    doc: {} as object,
    placeholder: undefined as string | undefined,
    focused: 0,
    insertGenerated(text: string, how: "replace" | "below", placeholder?: string) {
      history.push({ text: c.text, doc: c.doc });
      c.text = how === "replace" || !c.text ? text : `${c.text}\n\n${text}`;
      c.doc = {};
      c.placeholder = placeholder;
      // as the real editor's change does: the draft is dirty, autosave follows, and its listeners hear of it at once
      editDraft(key, {});
      for (const l of listeners) l();
      return { doc: c.doc };
    },
    undoGenerated(doc: unknown) {
      if (c.doc !== doc) return null;
      c.text = history.pop()!.text;
      c.doc = {};
      for (const l of listeners) l();
      return { doc: c.doc };
    },
    docToken: () => c.doc,
    subscribeDoc(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
    empty: () => !c.text,
    dismissGhost() {},
    snapshot: () => ({ html: "", text: c.text }),
    focus() { c.focused++; },
    type(text: string) { c.text += text; c.doc = {}; for (const l of listeners) l(); },
    dom: document.createElement("div"),
    getState: () => ({}),
    subscribe: () => () => {},
  };
  const stop = registerController(key, c as never);
  const unsub = c.subscribeDoc(() => store.noteBody(key));
  return { c, unmount() { stop(); unsub(); } };
}

const done = (text: string, over: Partial<Extract<AiComposeResult, { status: "done" }>> = {}): AiComposeResult => ({
  status: "done", text, subject: null, stop: "end",
  used: { levels: ["you", "account"], personFromOtherAccount: false, examples: 0, pastConversations: 0, threadMessages: 2, history: "found", learning: false, inboundSnippetOnly: false, language: "en", provider: "fake", model: "demo", reused: false },
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

  it("Esc mid-stream stops and discards, before the form's collapse; Esc on the strip is the form's", async () => {
    const { key, c } = await writing();
    delta(key, "Hi");
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(session(key)).toBeUndefined();
    expect(calls("ai.cancel")).toHaveLength(1);
    expect(c.text).toBe("");
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
    expect(store.previewMode(session(key))).toBeNull();
    delta(key, "Sho");
    expect(store.previewMode(session(key))).toBe("refine");
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(session(key)!.phase).toBe("strip");
    expect(c.text).toBe("First.");
    const shorter = calls("ai.compose").at(-1)!.params;
    expect(shorter.instruction).toBe("Shorter. Keep every fact and commitment.");
    expect(shorter.previousDraft).toBe("First.");
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
    expect(session(key)).toBeUndefined();
  });

  it("neither overwrites a subject edited since", async () => {
    const { key, c } = await filled();
    editDraft(key, { subject: "My own", subjectEdited: true });
    store.undoCommit(key);
    expect(c.text).toBe("");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("My own");
  });

  it("ordinary undo is the text's: the next change ends the strip, and the subject stays", async () => {
    const { key, c } = await filled();
    c.undoGenerated(c.doc);
    store.noteBody(key);
    expect(session(key)).toBeUndefined();
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated subject");
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

  it("caret on the first placeholder: the commit names it", async () => {
    const { c } = await writing();
    last("ai.compose").resolve(done("On [date] at [time].", { checks: { specifics: [], placeholders: ["[date]", "[time]"] } }));
    await tick();
    expect(c.placeholder).toBe("[date]");
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

  it("a cloud provider's first draft says what it sends, once, before anything goes", async () => {
    setApp({ settings: { ai: { provider: "anthropic", model: "x", local: false, tasks: {}, keys: {}, hasKey: true, keyConfirmed: true, profiles: {} } } as never });
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    await store.submit(key);
    expect(session(key)!.phase).toBe("telling");
    expect(calls("ai.compose")).toHaveLength(0);
    store.acknowledgeTold(key);
    await tick();
    expect(calls("ai.compose")).toHaveLength(1);
    store.stop(key);
    await store.openRow({ key });
    await store.submit(key);
    await tick();
    expect(session(key)!.phase).toBe("writing");
  });

  it("↑ recalls the last instruction", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    editor(key);
    await store.openRow({ key });
    store.setInstruction(key, "say it plainly");
    void store.submit(key);
    await tick();
    last("ai.resolveIntent").resolve({ decision: { kind: "route", route: { type: "keep-draft" } }, fromAccountId: null, confirmFailed: false });
    await tick();
    store.stop(key);
    await store.openRow({ key });
    expect(store.recallInstruction(key)).toBe(true);
    expect(session(key)!.instruction).toBe("say it plainly");
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
    expect(session(key)).toBeUndefined();
    rebuilt.unmount();
  });

  it("6: and if they aren't, nothing is overwritten, the subject stays and the strip just goes", async () => {
    const { key, unmount } = await writing({ mode: "new" });
    last("ai.compose").resolve(done("Body.", { subject: "Generated" }));
    await tick();
    unmount();
    editor(key, "Body, and more of mine.");
    editDraft(key, { bodyText: "Body, and more of mine." });
    store.undoCommit(key);
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("Body, and more of mine.");
    expect(useDrafts.getState().drafts[key]!.subject).toBe("Generated");
    expect(session(key)).toBeUndefined();
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
  it("⌘J over the strip refines; Esc there puts the strip back", async () => {
    const { key } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    await store.openRow({ key });
    expect(session(key)!.phase).toBe("input");
    expect(session(key)!.strip).not.toBeNull();
    expect(aiDraftHooks.escape(key)).toBe(true);
    expect(session(key)!.phase).toBe("strip");
    await store.openRow({ key });
    store.setInstruction(key, "mention Friday");
    await store.submit(key);
    expect(last("ai.compose").params).toMatchObject({ instruction: "mention Friday", previousDraft: "First." });
  });

  it("the strip goes at the next keystroke", async () => {
    const { key, c } = await writing();
    last("ai.compose").resolve(done("First."));
    await tick();
    c.type("!");
    expect(session(key)).toBeUndefined();
    expect(calls("ai.composeEnd")).toHaveLength(1);
  });

  it("off in Settings: ⌘J does nothing", async () => {
    useAiDraftUi.setState({ enabled: false });
    const { openAiDraft } = await import("./ai-draft-state");
    const key = createDraft({ ...newFields(1), toText: "ana@example.test" });
    openAiDraft({ key });
    await tick();
    expect(session(key)).toBeUndefined();
    expect(getApp().dialog).toBeNull();
  });
});
