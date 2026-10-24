/**
 * The draft write lifecycle against a fake backend and fake timers: when
 * saves go out, what an answer applies to, revisions, errors and retries,
 * and what send/discard/flush wait for.
 */
import type { Draft } from "@unica/core/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not in tests")) } }));

const { createDraft, discardDraft, draftForSend, editDraft, flushDraft, fromServer, loadDrafts, recipients, sendBody, setDraftTransport, threadDraftKey, useDrafts, validRecipients } = await import("./drafts");
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
  it("a draft Única only prefilled is never saved; the first edit saves 800 ms after typing stops", async () => {
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
  it("saved recipients are what was typed, unfinished ones included; Única's are marked; sending takes valid ones only", () => {
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
  });

  it("at startup every stored draft comes back; a conversation shows its most recent one", async () => {
    const base: Omit<Draft, "id" | "threadId" | "bodyText" | "updatedAt"> = { revision: 1, format: 2, accountId: 1, mode: "reply", to: [{ name: "Ana", email: "ana@example.com", auto: true }], cc: [], bcc: [], subject: "Re: x", subjectEdited: false, quotedText: "> x", includeQuote: true, inReplyToMessageId: 3, forwardOfMessageId: null, uiState: "collapsed" };
    await loadDrafts(async () => [
      { ...base, id: 1, threadId: 7, bodyText: "viejo", updatedAt: 1 },
      { ...base, id: 2, threadId: 7, bodyText: "nuevo", updatedAt: 2 },
      { ...base, id: 3, threadId: null, mode: "new", bodyText: "suelto", updatedAt: 3 },
    ]);
    const drafts = useDrafts.getState().drafts;
    expect(Object.keys(drafts)).toHaveLength(3);
    expect(drafts[threadDraftKey(drafts, 7)!]!.bodyText).toBe("nuevo");
    expect(fromServer({ ...base, id: 9, threadId: 7, bodyText: "", updatedAt: 0 })).toMatchObject({ toText: "Ana <ana@example.com>", auto: ["ana@example.com"], uiState: "collapsed", status: "saved" });
  });
});

describe("converting a draft to another mode keeps what the user wrote", () => {
  const me = { id: 1, email: "luis@acme.studio" } as import("@unica/core").Account;
  const yuki = { name: "Yuki", email: "yuki@acme.studio" };
  const lucas = { name: "Lucas", email: "lucas@acme.studio" };
  const detail = {
    thread: { id: 7, subject: "Propuesta" },
    messages: [{ id: 3, isSent: false, from: yuki, to: [{ name: "Luis", email: "luis@acme.studio" }, lucas], cc: [], subject: "Propuesta", date: 0, bodyText: "Hola", snippet: "Hola" }],
  } as unknown as import("@unica/core").ThreadDetail;

  it("reply → reply-all adds the others to Cc; the body and a typed recipient stay; the subject regenerates unless edited", () => {
    const reply = { ...replyFields("reply", detail, me), bodyText: "Mi texto", toText: "Yuki <yuki@acme.studio>, Extra <extra@example.com>" };
    const all = convertFields(reply, "replyAll", detail, me);
    expect(all.bodyText).toBe("Mi texto");
    expect(all.toText).toContain("extra@example.com");
    expect(all.ccText).toContain("lucas@acme.studio");
    expect(all.subject).toBe("Re: Propuesta");
    expect(convertFields({ ...reply, subject: "Mío", subjectEdited: true }, "forward", detail, me).subject).toBe("Mío");
  });

  it("→ forward clears what Única filled in, swaps the threading and the quote", () => {
    const all = convertFields({ ...replyFields("replyAll", detail, me), bodyText: "x" }, "forward", detail, me);
    expect(all.toText).toBe("");
    expect(all.ccText).toBe("");
    expect(all).toMatchObject({ mode: "forward", inReplyToMessageId: null, forwardOfMessageId: 3 });
    expect(all.quotedText).toContain("Mensaje reenviado");
  });

  it("reply-all → reply drops only the untouched auto recipients", () => {
    const all = { ...replyFields("replyAll", detail, me), ccText: "Lucas <lucas@acme.studio>, Mía <mia@example.com>" };
    const back = convertFields(all, "reply", detail, me);
    expect(back.ccText).toBe("Mía <mia@example.com>");
  });
});
