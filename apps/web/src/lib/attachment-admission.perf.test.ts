import { afterEach, expect, it, vi } from "vitest";
import type { Account, AttachmentRef, ThreadDetail } from "@terno/core";
import type { Draft, ParsedParamsOf } from "@terno/core/rpc";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { openCompose: compose, supersedeCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, draftPresentationThread, draftWorkPending, editDraft, flushDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { forwardFilesHeld } = await import("./forward-files");
const { resetSnacks } = await import("./snack");

const account = { id: 1, email: "me@test.com", signature: "a short signature" } as Account;
const ref: AttachmentRef = { assetId: "sealed-empty", filename: "empty.txt", mime: "text/plain", size: 0 };
const infoCall = ["attachments.info", { accountId: 1, assetId: ref.assetId }];
const contextCall = ["drafts.sourceContext", { messageId: 3 }];
type Save = ParsedParamsOf<"drafts.save">;
type Fault = "source-ref" | "undefined-save" | "fixed-revision" | "rejected-forward-save" | "omitted-quote";
type Outcome = { state: "pending" } | { state: "fulfilled"; value: unknown } | { state: "rejected"; error: unknown };
type Completion = { method: string; params: unknown; outcome: Outcome; pending: Promise<unknown> };
let fixture: ReturnType<typeof setup> | undefined;

function setup(size = 32, fault?: Fault) {
  expect(Object.keys(useDrafts.getState().drafts)).toEqual([]);
  expect(draftWorkPending()).toBe(false);
  expect(forwardFilesHeld()).toEqual({ sessions: 0, sources: 0, offered: 0, watching: false });
  const previousApp = getApp(), previousThreads = useThreads.getState();
  const original = "&".repeat(size);
  const detail: ThreadDetail = { thread: { id: 7, accountId: 1, subject: "source", snippet: "", lastDate: 0, fromName: "Sender", fromEmail: "sender@test.com", messageCount: 1, unread: false, starred: false, hasAttachments: true, categoryIds: [], inInbox: true, inTrash: false, inSpam: false }, messages: [{ id: 3, threadId: 7, replyTo: [], snippet: "", bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, hasAttachments: true, rfcMessageId: null, references: [], listId: null, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: original, attachments: [{ id: 1, ...ref }] }] };
  const entries: Completion[] = [], saves: Save[] = [];
  const publications: { mode: string; id: number | null; generation?: string; revision: number; localRev: number; savedRev: number; status: string; source?: number | null; presentation: number | null }[] = [];
  const rejection = { code: "BAD_REQUEST", message: "synthetic save refusal" };
  let revision = 0;
  function observe<T>(method: string, params: unknown, work: () => Promise<T>): Promise<T> {
    const entry: Completion = { method, params, outcome: { state: "pending" }, pending: Promise.resolve() };
    entries.push(entry);
    try {
      const pending = work(); entry.pending = pending;
      void pending.then(value => { entry.outcome = { state: "fulfilled", value }; }, error => { entry.outcome = { state: "rejected", error }; });
      return pending;
    } catch (error) {
      entry.outcome = { state: "rejected", error };
      throw error;
    }
  }
  rpc.mockImplementation((method: string, params: unknown) => observe(method, params, async () => {
    await new Promise<void>((r) => setImmediate(r));
    if (method === "attachments.info") return ref;
    if (method === "drafts.sourceContext") return fault === "source-ref" ? ref : { threadId: 7, accountId: 1 };
    throw new Error(`Unexpected fixture RPC ${method}`);
  }));
  setDraftTransport((method, params) => observe(method, params, async () => {
    if (method !== "drafts.save") throw new Error(`Unexpected fixture transport ${method}`);
    const p = params as Save;
    if (fault === "omitted-quote" && p.mode === "forward") { delete p.quotedText; delete p.includeQuote; }
    saves.push(p);
    if (fault === "undefined-save") return undefined;
    if (fault === "rejected-forward-save" && p.mode === "forward") throw rejection;
    const saved: Draft = {
      id: 9, generation: "generation", revision: fault === "fixed-revision" ? (revision = 1) : ++revision, format: 2,
      accountId: p.accountId, threadId: p.threadId ?? null, mode: p.mode ?? "new", to: p.to, cc: p.cc, bcc: p.bcc,
      subject: p.subject, subjectEdited: p.subjectEdited ?? false, bodyText: p.bodyText, bodyHtml: p.bodyHtml,
      attachments: p.attachments ?? [], quotedText: p.quotedText ?? "", includeQuote: p.includeQuote ?? false,
      inReplyToMessageId: p.inReplyToMessageId ?? null, forwardOfMessageId: p.forwardOfMessageId ?? null,
      showSourceContext: p.showSourceContext ?? false, presentationThreadId: p.showSourceContext ? 7 : null,
      uiState: p.uiState ?? "open", updatedAt: 0,
    };
    return saved;
  }));
  const key = createDraft(replyFields("reply", detail, account));
  const stop = useDrafts.subscribe(state => {
    const d = state.drafts[key];
    if (d) publications.push({ mode: d.mode, id: d.id, generation: d.generation, revision: d.revision, localRev: d.localRev, savedRev: d.savedRev, status: d.status, source: d.sourceContextThreadId, presentation: draftPresentationThread(d) });
  });
  editDraft(key, { bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  useThreads.setState({ details: new Map([[7, detail]]) });
  setApp({ accounts: [account], selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key }, draftFocus: null, compose: null, dialog: null, fatal: null });
  const flush = () => observe("flush", { key }, () => flushDraft(key));
  async function drain() {
    let joined = 0;
    const join = async () => {
      while (joined < entries.length) {
        const batch = entries.slice(joined); joined = entries.length;
        await Promise.allSettled(batch.map(entry => entry.pending));
      }
    };
    await join();
    await Promise.allSettled([flush()]);
    await join();
    expect(draftWorkPending()).toBe(false);
    expect(forwardFilesHeld().sessions).toBe(0);
  }
  function assertSaveContent(allowFault = false) {
    for (const [index, entry] of entries.filter(e => e.method === "drafts.save").entries()) {
      const mode = index === 0 || fault === "fixed-revision" ? "reply" : "forward";
      const fields = replyFields(mode, detail, account);
      const p = entry.params as Save;
      const expected = {
        accountId: 1, threadId: 7, mode, to: mode === "reply" ? [{ name: "Sender", email: "sender@test.com", auto: true }] : [], cc: [], bcc: [],
        subject: fault === "fixed-revision" && index === 1 ? "authored subject" : fields.subject,
        subjectEdited: fault === "fixed-revision" && index === 1,
        bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: mode === "forward" ? [{ ...ref, contentId: null }] : [],
        inReplyToMessageId: fields.inReplyToMessageId, forwardOfMessageId: fields.forwardOfMessageId, showSourceContext: mode === "forward", uiState: "open",
      };
      expect(p, "complete saved request").toMatchObject(expected);
      const omitted = allowFault && fault === "omitted-quote" && index === 1;
      if (omitted) { expect(p).not.toHaveProperty("quotedText"); expect(p).not.toHaveProperty("includeQuote"); }
      else expect(p, `Persisted ${mode === "forward" ? "Forward" : "Reply"} quote`).toMatchObject({ quotedText: fields.quotedText, includeQuote: true });
      if (entry.outcome.state === "fulfilled" && entry.outcome.value) {
        expect(entry.outcome.value, "complete saved ACK").toMatchObject({ ...expected, quotedText: omitted ? "" : fields.quotedText, includeQuote: !omitted });
      }
    }
  }
  function assertTerminal(allowFault = true) {
    assertSaveContent(allowFault);
    const saved = entries.filter(entry => entry.method === "drafts.save");
    if (fault) expect(saved).toHaveLength(fault === "source-ref" || fault === "undefined-save" ? 1 : 2);
    for (const [index, entry] of saved.entries()) {
      const p = entry.params as Save;
      expect([p.id, p.generation, p.baseRevision], "save request predecessor").toEqual(index ? [9, "generation", index] : [undefined, undefined, undefined]);
      if (entry.outcome.state === "fulfilled" && entry.outcome.value) {
        expect(entry.outcome.value, "Invalid save ACK identity").toMatchObject({ id: 9, generation: "generation", revision: allowFault && fault === "fixed-revision" ? 1 : index + 1, format: 2, showSourceContext: p.showSourceContext, presentationThreadId: p.showSourceContext ? 7 : null });
      }
    }
    for (const entry of entries) {
      if (allowFault && fault === "rejected-forward-save" && entry === saved[1]) {
        expect(entry.outcome).toEqual({ state: "rejected", error: rejection });
      } else {
        expect(entry.outcome.state, `Unexpected terminal outcome: ${entry.method}`).toBe("fulfilled");
        if (entry.method === "drafts.save" || entry.method === "attachments.info" || entry.method === "drafts.sourceContext") {
          if (allowFault && fault === "undefined-save" && entry === saved[0]) expect(entry.outcome).toEqual({ state: "fulfilled", value: undefined });
          else if (entry.outcome.state === "fulfilled") {
            expect(entry.outcome.value, `Invalid default outcome: ${entry.method}`).toBeDefined();
            expect(entry.outcome.value, `Invalid default outcome: ${entry.method}`).not.toBeNull();
          }
        }
      }
    }
    expect(rpc.mock.calls).toEqual(fault === "undefined-save" || fault === "fixed-revision" ? [infoCall] : [infoCall, contextCall]);
    for (const entry of entries.filter(e => e.method === "attachments.info" || e.method === "drafts.sourceContext")) {
      expect(entry.outcome).toEqual({ state: "fulfilled", value: entry.method === "attachments.info" || fault === "source-ref" ? ref : { threadId: 7, accountId: 1 } });
    }
  }
  function assertSaved() {
    assertSaveContent();
    const d = useDrafts.getState().drafts[key]!;
    expect(d).toMatchObject({ id: 9, generation: "generation", revision: saves.length, savedRev: d.localRev, status: "saved", mode: "forward", threadId: 7, accountId: 1, inReplyToMessageId: null, forwardOfMessageId: 3, showSourceContext: true, sourceContextThreadId: 7, bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: [{ ...ref, contentId: null }] });
    expect(d.recovery).toBeUndefined();
    expect(draftPresentationThread(d)).toBe(7);
    expect(saves.length).toBeGreaterThanOrEqual(2);
    expect(saves[0]).toMatchObject({ mode: "reply", attachments: [], showSourceContext: false });
    expect(saves.at(-1)).toMatchObject({ mode: "forward", showSourceContext: true, attachments: [{ ...ref, contentId: null }], bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  }
  const result = { key, original, entries, saves, publications, rejection, observe, flush, drain, assertTerminal, assertSaved, restore: () => { stop(); useApp.setState(previousApp, true); useThreads.setState(previousThreads, true); } };
  fixture = result;
  return result;
}
function openCompose(...args: Parameters<typeof compose>) {
  return fixture!.observe("compose", args, () => compose(...args));
}
async function cleanup() {
  const f = fixture;
  if (!f) return;
  const errors: unknown[] = [];
  const finish = (work: () => void) => { try { work(); } catch (error) { errors.push(error); } };
  try { await f.drain(); f.assertTerminal(); } catch (error) { errors.push(error); }
  finish(supersedeCompose);
  finish(() => forgetDraft(f.key));
  finish(() => { expect(forwardFilesHeld()).toEqual({ sessions: 0, sources: 0, offered: 0, watching: false }); });
  finish(f.restore);
  fixture = undefined;
  finish(() => setDraftTransport((method, params) => rpc(method, params)));
  finish(() => { rpc.mockReset(); });
  finish(resetSnacks);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Forward fixture cleanup failed");
}
afterEach(cleanup);

for (const size of [1024 * 1024, 3 * 1024 * 1024]) it(`complete Forward admission bounds preparation, escaping, assembly and budget scan (${size} quote characters)`, async () => {
  const { key, original } = setup(size);
  let previous = process.threadCpuUsage(), maxCpu = 0, turns = 0, active = true;
  const record = () => { const cpu = process.threadCpuUsage(previous); maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000); previous = process.threadCpuUsage(); };
  const heartbeat = () => { record(); turns++; if (active) timer = setImmediate(heartbeat); };
  let timer = setImmediate(heartbeat);
  try { await openCompose("forward", 7); record(); }
  finally { active = false; clearImmediate(timer); }
  process.stderr.write(`[complete Forward admission ${size}] ${turns} task turns; maxCPU ${maxCpu.toFixed(2)} ms\n`);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: [{ ...ref, contentId: null }] });
  expect(useDrafts.getState().drafts[key]!.quotedText).toContain(original);
  expect(turns).toBeGreaterThan(100);
  expect(maxCpu).toBeLessThanOrEqual(15);
  await fixture!.drain();
  fixture!.assertSaved();
});

function assertReply() {
  const d = useDrafts.getState().drafts[fixture!.key]!;
  expect(d).toMatchObject({ mode: "reply", threadId: 7, inReplyToMessageId: 3, forwardOfMessageId: null, bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: [] });
  expect(d.quotedText).toContain(fixture!.original);
  expect(fixture!.publications.every(p => p.mode === "reply")).toBe(true);
  process.stderr.write(`[Forward refusal ${fixture!.entries.map(e => e.method).join(" -> ")}] ${JSON.stringify(fixture!.publications)}\n`);
  return d;
}

it("control: an attachment-shaped sourceContext refuses at the final source gate after a valid save", async () => {
  const f = setup(32, "source-ref");
  await openCompose("forward", 7);
  const d = assertReply();
  expect(rpc.mock.calls).toEqual([infoCall, contextCall]);
  expect(f.entries.find(e => e.method === "drafts.sourceContext")!.outcome).toEqual({ state: "fulfilled", value: ref });
  expect(d).toMatchObject({ id: 9, generation: "generation", revision: 1, status: "saved", showSourceContext: false });
  expect(d.sourceContextThreadId).toBeUndefined();
  expect(f.saves).toHaveLength(1);
});

it("control: an undefined create outcome refuses attachment admission before source lookup", async () => {
  const f = setup(32, "undefined-save");
  await openCompose("forward", 7);
  expect(assertReply()).toMatchObject({ id: null, revision: 0, status: "error", recovery: { state: "missing" } });
  expect(rpc.mock.calls).toEqual([infoCall]);
  expect(f.saves).toHaveLength(1);
  await f.drain();
  expect(() => f.assertTerminal(false)).toThrow("Invalid default outcome: drafts.save");
});

it("control: a fixed create revision cannot authorize the next update's Forward admission", async () => {
  const f = setup(32, "fixed-revision");
  await f.flush();
  expect(useDrafts.getState().drafts[f.key]).toMatchObject({ id: 9, generation: "generation", revision: 1, status: "saved" });
  editDraft(f.key, { subject: "authored subject", subjectEdited: true });
  await openCompose("forward", 7);
  expect(assertReply()).toMatchObject({ id: 9, generation: "generation", revision: 1, status: "saved", subject: "authored subject" });
  expect(rpc.mock.calls).toEqual([infoCall]);
  expect(f.saves).toHaveLength(2);
  expect(f.saves[1]).toMatchObject({ id: 9, generation: "generation", baseRevision: 1 });
  expect(f.entries.filter(e => e.method === "drafts.save").map(e => e.outcome)).toMatchObject([{ state: "fulfilled", value: { revision: 1 } }, { state: "fulfilled", value: { revision: 1 } }]);
  await f.drain();
  expect(() => f.assertTerminal(false)).toThrow("Invalid save ACK identity");
});

it("control: a rejected post-admission save cannot disappear in the Writer drain", async () => {
  const f = setup(32, "rejected-forward-save");
  await openCompose("forward", 7);
  expect(useDrafts.getState().drafts[f.key]).toMatchObject({ mode: "forward", attachments: [{ ...ref, contentId: null }] });
  await f.drain();
  expect(useDrafts.getState().drafts[f.key]).toMatchObject({ status: "error", tooLong: true, bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  expect(f.entries.filter(e => e.method === "drafts.save").at(-1)!.outcome).toEqual({ state: "rejected", error: f.rejection });
  expect(() => f.assertTerminal(false)).toThrow("Unexpected terminal outcome: drafts.save");
});

it("control: a drain failure still releases owned state and preserves its error", async () => {
  const previousApp = getApp(), previousThreads = useThreads.getState();
  const f = setup();
  await openCompose("forward", 7);
  await f.drain(); f.assertTerminal();
  const drain = f.drain, failure = new Error("synthetic terminal drain failure");
  f.drain = async () => { throw failure; };
  try {
    await expect(cleanup()).rejects.toBe(failure);
    expect(Object.keys(useDrafts.getState().drafts), "owned draft released after drain failure").toEqual([]);
    expect(getApp()).toEqual(previousApp); expect(useThreads.getState()).toEqual(previousThreads);
    expect(fixture).toBeUndefined(); expect(rpc.mock.calls).toEqual([]);
  } finally { f.drain = drain; if (fixture) await cleanup(); }
});

it("control: an omitted outgoing quote cannot pass persisted Forward assertions", async () => {
  const f = setup(32, "omitted-quote");
  await openCompose("forward", 7);
  await f.drain();
  expect(useDrafts.getState().drafts[f.key]!.quotedText).toContain(f.original);
  expect(f.saves.at(-1)!.quotedText).toBeUndefined();
  expect(() => f.assertSaved()).toThrow("Persisted Forward quote");
});
