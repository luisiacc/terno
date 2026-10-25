/**
 * The draft write lifecycle against a fake backend and fake timers: when
 * saves go out, what an answer applies to, revisions, errors and retries,
 * and what send/discard/flush wait for.
 */
import type { Draft } from "@terno/core/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not in tests")) } }));

const { attachBody, createDraft, discardDraft, draftForSend, editDraft, fieldsOf, flushDraft, fromServer, loadDrafts, recipients, restoreDiscarded, retryDraft, sendBody, sendHtml, setDraftTransport, threadDraftKey, useDrafts, validRecipients } = await import("./drafts");
const { convertFields, newFields, replyFields } = await import("./compose-fields");

interface Pending {
  method: string;
  params: Record<string, unknown>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}
let calls: Pending[];
let stored: Map<number, Draft>;
let nextId: number;

/** Answers the oldest call as a real backend would. */
async function answer(ok = true) {
  const c = calls.shift()!;
  if (!ok) c.reject(new Error("disco lleno"));
  else if (c.method === "drafts.delete") {
    stored.delete(c.params.id as number);
    c.resolve({ ok: true });
  } else {
    const p = c.params as { id?: number; baseRevision?: number; bodyText: string };
    const prev = p.id !== undefined ? stored.get(p.id) : undefined;
    if (p.id !== undefined && !prev) c.resolve(null);
    else {
      const replace = prev && (p.baseRevision === undefined || p.baseRevision === prev.revision);
      const d = { ...(p as unknown as Draft), id: replace ? prev!.id : nextId++, revision: replace ? prev!.revision + 1 : 1 } as Draft;
      stored.set(d.id, d);
      c.resolve(d);
    }
  }
  await vi.advanceTimersByTimeAsync(0);
}

const draft = () => createDraft({ ...newFields(1), toText: "Ana <ana@example.com>" });
const state = (key: string) => useDrafts.getState().drafts[key]!;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  stored = new Map();
  nextId = 10;
  useDrafts.setState({ drafts: {} });
  setDraftTransport((method, params) => new Promise((resolve, reject) => calls.push({ method, params: params as Record<string, unknown>, resolve, reject })), () => Date.now());
});
afterEach(() => vi.useRealTimers());

describe("the draft writer", () => {
  it("a draft Terno only prefilled is never saved; the first edit saves 800 ms after typing stops", async () => {
    const k = draft();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    editDraft(k, { bodyText: "H" });
    await vi.advanceTimersByTimeAsync(500);
    editDraft(k, { bodyText: "Ho" });
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.bodyText).toBe("Ho");
    expect(state(k).status).toBe("saving");
    await answer();
    expect(state(k)).toMatchObject({ status: "saved", id: 10, revision: 1 });
  });

  it("while typing continuously a save goes out at least every 5 s", async () => {
    const k = draft();
    for (let i = 0; i < 30; i++) {
      editDraft(k, { bodyText: "x".repeat(i + 1) });
      await vi.advanceTimersByTimeAsync(300);
    }
    // 9 s of typing: the 5 s ceiling fired at least once
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("one save in flight at a time; edits during it are saved after it answers, on the revision it returned", async () => {
    const k = draft();
    editDraft(k, { bodyText: "uno" });
    await vi.advanceTimersByTimeAsync(800);
    editDraft(k, { bodyText: "uno dos" });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(1); // the second waits for the first
    await answer();
    expect(state(k).status).toBe("saving"); // the newer text went out at once
    expect(calls[0]!.params).toMatchObject({ id: 10, baseRevision: 1, bodyText: "uno dos" });
    await answer();
    expect(state(k)).toMatchObject({ status: "saved", revision: 2 });
  });

  it("«guardado» only for the acknowledged revision; an answer goes to the draft it was sent for", async () => {
    const a = draft();
    const b = draft();
    editDraft(a, { bodyText: "para a" });
    await vi.advanceTimersByTimeAsync(800);
    editDraft(b, { bodyText: "para b" });
    editDraft(a, { bodyText: "para a, más" });
    await answer(); // a's first save
    expect(state(a).status).not.toBe("saved");
    expect(state(a).id).toBe(10);
    expect(state(b).id).toBeNull();
  });

  it("a failed save says so and retries after 1 s; the text stays", async () => {
    const k = draft();
    editDraft(k, { bodyText: "importante" });
    await vi.advanceTimersByTimeAsync(800);
    await answer(false);
    expect(state(k)).toMatchObject({ status: "error", bodyText: "importante" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await answer();
    expect(state(k).status).toBe("saved");
  });

  it("flush cancels the debounce and waits for the save in flight and the one after it", async () => {
    const k = draft();
    editDraft(k, { bodyText: "a" });
    await vi.advanceTimersByTimeAsync(800);
    editDraft(k, { bodyText: "ab" });
    let flushed = false;
    void flushDraft(k).then(() => (flushed = true));
    await answer();
    expect(flushed).toBe(false);
    await answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(true);
    expect(stored.get(10)!.bodyText).toBe("ab");
  });

  it("discard waits for a save in flight, then deletes what it created (no orphan)", async () => {
    const k = draft();
    editDraft(k, { bodyText: "borrar" });
    await vi.advanceTimersByTimeAsync(800);
    const gone = discardDraft(k);
    await answer(); // the save creates id 10
    await answer(); // then the delete
    expect((await gone)?.bodyText).toBe("borrar");
    expect(stored.size).toBe(0);
    expect(useDrafts.getState().drafts[k]).toBeUndefined();
  });

  it("send gets the content after the save in flight answered, with its id", async () => {
    const k = draft();
    editDraft(k, { bodyText: "enviar" });
    await vi.advanceTimersByTimeAsync(800);
    const ready = draftForSend(k);
    await answer();
    expect(await ready).toMatchObject({ id: 10, bodyText: "enviar" });
    // nothing else is saved after it
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("a save answered with null (sent or discarded elsewhere) drops the draft", async () => {
    const k = draft();
    editDraft(k, { bodyText: "x" });
    await vi.advanceTimersByTimeAsync(800);
    await answer();
    stored.clear();
    editDraft(k, { bodyText: "xy" });
    await vi.advanceTimersByTimeAsync(800);
    await answer();
    expect(useDrafts.getState().drafts[k]).toBeUndefined();
  });
});

describe("drafts: helpers and restore", () => {
  it("saved recipients are what was typed, unfinished ones included; Terno's are marked; sending takes valid ones only", () => {
    expect(recipients('Ana <ana@example.com>, "Pérez, Luis" <luis@example.com>, bob@', ["ANA@example.com"])).toEqual([
      { name: "Ana", email: "ana@example.com", auto: true },
      { name: "Pérez, Luis", email: "luis@example.com" },
      { name: "", email: "bob@" },
    ]);
    expect(validRecipients("ana@example.com, bob@")).toEqual([{ name: "", email: "ana@example.com" }]);
  });

  it("an unfinished recipient is saved as typed, so it comes back", async () => {
    const k = draft();
    editDraft(k, { toText: "alice@example.com, bob@" });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls[0]!.params.to).toEqual([
      { name: "", email: "alice@example.com" },
      { name: "", email: "bob@" },
    ]);
    await answer();
    expect(fromServer(stored.get(10)!).toText).toBe("alice@example.com, bob@");
  });

  it("what is sent is what the user wrote, then the kept quote, once", () => {
    expect(sendBody({ bodyText: "Sí, va.\n\n", quotedText: "> hola", includeQuote: true })).toBe("Sí, va.\n\n> hola");
    expect(sendBody({ bodyText: "Sí, va.", quotedText: "> hola", includeQuote: false })).toBe("Sí, va.");
    // the From account's signature goes between what is written and the quote, behind the "-- " line
    expect(sendBody({ bodyText: "Sí, va.\n", quotedText: "> hola", includeQuote: true }, "Luis\nAcme Studio\n\n")).toBe("Sí, va.\n\n-- \nLuis\nAcme Studio\n\n> hola");
    expect(sendBody({ bodyText: "", quotedText: "", includeQuote: false }, "Luis")).toBe("-- \nLuis");
    expect(sendBody({ bodyText: "Hola", quotedText: "", includeQuote: false }, "  \n")).toBe("Hola");
  });

  it("at startup every stored draft comes back; a conversation shows its most recent one", async () => {
    const base: Omit<Draft, "id" | "threadId" | "bodyText" | "updatedAt"> = { revision: 1, format: 2, accountId: 1, mode: "reply", to: [{ name: "Ana", email: "ana@example.com", auto: true }], cc: [], bcc: [], subject: "Re: x", subjectEdited: false, bodyHtml: "", quotedText: "> x", includeQuote: true, inReplyToMessageId: 3, forwardOfMessageId: null, uiState: "collapsed" };
    await loadDrafts(async () => [
      { ...base, id: 1, threadId: 7, bodyText: "viejo", updatedAt: 1 },
      { ...base, id: 2, threadId: 7, bodyText: "nuevo", updatedAt: 2 },
      { ...base, id: 3, threadId: null, mode: "new", bodyText: "suelto", updatedAt: 3 },
    ]);
    const drafts = useDrafts.getState().drafts;
    expect(Object.keys(drafts)).toHaveLength(3);
    expect(drafts[threadDraftKey(drafts, 7)!]!.bodyText).toBe("nuevo");
    expect(fromServer({ ...base, id: 9, threadId: 7, bodyText: "", updatedAt: 0 })).toMatchObject({ toText: "Ana <ana@example.com>", auto: { to: ["ana@example.com"], cc: [], bcc: [] }, uiState: "collapsed", status: "saved" });
  });
});

describe("converting a draft to another mode keeps what the user wrote", () => {
  const me = { id: 1, email: "luis@acme.studio" } as import("@terno/core").Account;
  const yuki = { name: "Yuki", email: "yuki@acme.studio" };
  const lucas = { name: "Lucas", email: "lucas@acme.studio" };
  const detail = {
    thread: { id: 7, subject: "Propuesta" },
    messages: [{ id: 3, isSent: false, from: yuki, to: [{ name: "Luis", email: "luis@acme.studio" }, lucas], cc: [], subject: "Propuesta", date: 0, bodyText: "Hola", snippet: "Hola" }],
  } as unknown as import("@terno/core").ThreadDetail;

  it("reply → reply-all adds the others to Cc; the body and a typed recipient stay; the subject regenerates unless edited", () => {
    const reply = { ...replyFields("reply", detail, me), bodyText: "Mi texto", toText: "Yuki <yuki@acme.studio>, Extra <extra@example.com>" };
    const all = convertFields(reply, "replyAll", detail, me);
    expect(all.bodyText).toBe("Mi texto");
    expect(all.toText).toContain("extra@example.com");
    expect(all.ccText).toContain("lucas@acme.studio");
    expect(all.subject).toBe("Re: Propuesta");
    expect(convertFields({ ...reply, subject: "Mío", subjectEdited: true }, "forward", detail, me).subject).toBe("Mío");
  });

  it("→ forward clears what Terno filled in, swaps the threading and the quote", () => {
    const all = convertFields({ ...replyFields("replyAll", detail, me), bodyText: "x" }, "forward", detail, me);
    expect(all.toText).toBe("");
    expect(all.ccText).toBe("");
    expect(all).toMatchObject({ mode: "forward", inReplyToMessageId: null, forwardOfMessageId: 3 });
    expect(all.quotedText).toContain("Forwarded message");
  });

  it("a recipient the user typed is theirs in that field: reply → add Lucas to Para → reply-all → forward keeps Lucas", () => {
    const reply = replyFields("reply", detail, me);
    const typed = { ...reply, toText: `${reply.toText}, Lucas <lucas@acme.studio>`, bodyText: "x" };
    const all = convertFields(typed, "replyAll", detail, me);
    // Lucas is already in Para (typed): reply-all doesn't add him to Cc again
    expect(all.toText).toContain("lucas@acme.studio");
    expect(all.ccText).not.toContain("lucas@acme.studio");
    const fwd = convertFields(all, "forward", detail, me);
    expect(fwd.toText).toBe("Lucas <lucas@acme.studio>");
    expect(fwd.ccText).toBe("");
  });

  it("reply-all → reply drops only the untouched auto recipients", () => {
    const all = { ...replyFields("replyAll", detail, me), ccText: "Lucas <lucas@acme.studio>, Mía <mia@example.com>" };
    const back = convertFields(all, "reply", detail, me);
    expect(back.ccText).toBe("Mía <mia@example.com>");
  });
});

describe("the editor's body (plan 16)", () => {
  /** a stand-in editor: its document is a string; reads are counted */
  function editor(k: string, initial = "") {
    let doc = initial;
    const reads = { n: 0 };
    const body = attachBody(k, () => {
      reads.n++;
      return { html: doc ? `<div><b>${doc}</b></div>` : "", text: doc };
    });
    return {
      reads,
      body,
      type(text: string) {
        doc += text;
        body.changed();
      },
    };
  }

  it("typing marks the draft dirty without serializing; the save serializes once, from the same document as its revision", async () => {
    const k = draft();
    const ed = editor(k);
    ed.type("H");
    const after = useDrafts.getState().drafts;
    for (const ch of "ola") ed.type(ch);
    expect(ed.reads.n).toBe(0);
    // one revision covers the keystrokes until the save: the store isn't touched per key (nothing re-renders)
    expect(useDrafts.getState().drafts).toBe(after);
    expect(state(k)).toMatchObject({ localRev: 1, status: "dirty", bodyText: "" });
    await vi.advanceTimersByTimeAsync(800);
    expect(ed.reads.n).toBe(1);
    expect(calls[0]!.params).toMatchObject({ bodyText: "Hola", bodyHtml: "<div><b>Hola</b></div>" });
    // typing while that save is in flight: the next save carries it (and serializes again, once)
    ed.type(" Ana");
    await answer();
    expect(calls[0]!.params).toMatchObject({ bodyText: "Hola Ana", bodyHtml: "<div><b>Hola Ana</b></div>" });
    expect(ed.reads.n).toBe(2);
    await answer();
    expect(state(k)).toMatchObject({ status: "saved", canonical: true, bodyHtml: "<div><b>Hola Ana</b></div>" });
  });

  it("a snapshot of the fields (a conversion and its undo) and a send see what the editor has, not the last save", async () => {
    const k = draft();
    const ed = editor(k);
    ed.type("Sí");
    expect(fieldsOf(state(k))).toMatchObject({ bodyText: "Sí", bodyHtml: "<div><b>Sí</b></div>" });
    ed.type(" va");
    const sending = draftForSend(k);
    expect((await sending)!.bodyHtml).toBe("<div><b>Sí va</b></div>");
  });

  it("a body set from elsewhere bumps bodyVersion (the editor reloads); the same body doesn't", () => {
    const k = draft();
    const ed = editor(k);
    ed.type("uno");
    const v = state(k).bodyVersion;
    editDraft(k, { bodyText: "uno", bodyHtml: "<div><b>uno</b></div>", subject: "x" });
    expect(state(k).bodyVersion).toBe(v);
    editDraft(k, { bodyText: "otro", bodyHtml: "" });
    expect(state(k)).toMatchObject({ bodyVersion: v + 1, bodyText: "otro", bodyHtml: "", canonical: false });
    // and the editor's stale document doesn't overwrite it at the next save
    expect(fieldsOf(state(k)).bodyText).toBe("otro");
  });

  it("unmounting writes what the editor has; a discarded draft comes back formatted; a source of a deleted draft does nothing", async () => {
    const k = draft();
    const ed = editor(k);
    ed.type("Hola");
    ed.body.dispose();
    expect(state(k).bodyHtml).toBe("<div><b>Hola</b></div>");
    const ed2 = editor(k, "Hola");
    ed2.type("!");
    const gone = await discardDraft(k);
    expect(gone!.bodyHtml).toBe("<div><b>Hola!</b></div>");
    expect(useDrafts.getState().drafts[k]).toBeUndefined();
    ed2.type("?");
    ed2.body.dispose();
    expect(useDrafts.getState().drafts[k]).toBeUndefined();
    const back = restoreDiscarded(gone!);
    expect(state(back)).toMatchObject({ bodyText: "Hola!", bodyHtml: "<div><b>Hola!</b></div>" });
  });

  it("Codex review 2: a send waiting for a save in flight gets what was typed meanwhile, even when that save fails", async () => {
    const k = draft();
    const ed = editor(k);
    ed.type("A");
    await vi.advanceTimersByTimeAsync(800);
    expect(calls[0]!.params.bodyText).toBe("A");
    const sending = draftForSend(k);
    ed.type("B");
    await answer(false);
    expect((await sending)!.bodyText).toBe("AB");
  });

  it("Codex review 2: a source that isn't the schema's (a stand-in over a stored body) leaves the draft untrusted", () => {
    const k = draft();
    const body = attachBody(k, () => ({ html: "<div>stored<img src=x></div><div>more</div>", text: "stored\nmore" }), { canonical: false });
    body.changed();
    expect(fieldsOf(state(k)).bodyHtml).toContain("<img");
    expect(state(k).canonical).toBe(false);
  });

  it("a save refused as invalid (too long) says so and doesn't retry by itself; Retry tries again", async () => {
    const k = draft();
    editDraft(k, { bodyText: "x" });
    await vi.advanceTimersByTimeAsync(800);
    const c = calls.shift()!;
    c.reject(Object.assign(new Error("too big"), { code: "BAD_REQUEST" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(state(k)).toMatchObject({ status: "error", tooLong: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(0);
    retryDraft(k);
    expect(calls).toHaveLength(1);
  });

  it("the HTML sent: the written part (trailing empty lines dropped), the signature, then the quote as nested blockquotes", () => {
    const html = sendHtml("<div><b>Sí</b></div><div><br></div><div><br></div>", { quotedText: "El lunes, Ana escribió:\n> hola", includeQuote: true }, "Luis\nAcme");
    expect(html).toBe(
      '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div><b>Sí</b></div><div><br></div><div>-- <br>Luis<br>Acme</div><div><br></div><div>El lunes, Ana escribió:</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>hola</div></blockquote></body></html>',
    );
    expect(sendHtml("<div>x</div>", { quotedText: "> q", includeQuote: false })).not.toContain("blockquote");
  });
});
