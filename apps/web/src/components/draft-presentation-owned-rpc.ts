import { expect, vi } from "vitest";
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from "node:timers";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { contract, type ResultOf } from "@terno/core/rpc";
import type { LocalDraft } from "~/lib/drafts";

type Draft = NonNullable<ResultOf<"drafts.save">>;
type Call = Parameters<typeof import("~/lib/drafts").setDraftTransport>[0];
type Clock = () => number;
type Owner = { call: Call; clock: Clock; frame?: Frame };
type Outcome = { ordinal: number; channel: "model" | "override" | "rpc" | "aux"; method: string; params: unknown; terminal: "pending" | "fulfilled" | "rejected" | "sync-threw"; result?: unknown; error?: unknown; settled?: number };
type Stage = Readonly<Record<string, string | number | boolean | null>>;
type Frame = { previous: Owner; closing: boolean; outcomes: Outcome[]; pending: Set<Promise<unknown>>; unexpected: unknown[]; events: Stage[]; next: number; stops: Array<() => void>; objects: WeakMap<object, number>; objectSeq: number; title: string; ledgerWritten?: boolean };
const ownership = vi.hoisted(() => ({ current: undefined as Owner | undefined, active: undefined as Frame | undefined, rawSet: undefined as typeof import("~/lib/drafts").setDraftTransport | undefined, unavailable: false }));

// Test-only module facade: forwards each existing setter once and remembers its exact port+clock.
vi.mock("~/lib/drafts", async (original) => {
  const actual = await original<typeof import("~/lib/drafts")>();
  const { client } = await import("~/rpc/connection");
  if (Object.keys(actual.useDrafts.getState().drafts).length) quarantine("facade-after-live-draft-owner");
  const initial: Owner = { call: (method, params) => client.call(method, params as never), clock: () => Date.now() };
  actual.setDraftTransport(initial.call, initial.clock);
  ownership.current = initial; ownership.rawSet = actual.setDraftTransport;
  return { ...actual, setDraftTransport(call: Call, clock?: Clock) {
    const frame = ownership.active;
    if (frame?.closing) throw new Error("Presentation fixture setter after terminal drain began");
    const owner: Owner = { call, clock: clock ?? ownership.current!.clock, frame };
    const dispatch: Call = frame ? (method, params) => record(frame, "override", method, params, () => call(method, params)) : call;
    owner.call = dispatch;
    actual.setDraftTransport(dispatch, owner.clock); ownership.current = owner;
  } };
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const copy = <T,>(value: T): T => {
  let size = 0;
  const branch = new WeakSet<object>();
  const measure = (v: unknown, depth = 0): void => {
    size += typeof v === "string" ? v.length * 2 : 8;
    if (size > 65536 || depth > 32) throw new Error("Presentation RPC snapshot bound");
    if (v && typeof v === "object") {
      if (branch.has(v)) throw new Error("Cyclic presentation RPC payload");
      branch.add(v); for (const [key, child] of Object.entries(v)) { size += key.length * 2; measure(child, depth + 1); } branch.delete(v);
    }
  };
  measure(value); return freeze(structuredClone(value));
};
function quarantine(reason: string): never {
  ownership.unavailable = true;
  console.error(`TERNO_PRESENTATION_FIXTURE_UNAVAILABLE:${reason}`);
  throw new Error(`Presentation fixture unavailable: ${reason}`);
}
function event(frame: Frame, values: Stage) {
  if (frame.events.length >= 256) quarantine("stage-cap");
  frame.events.push(Object.freeze({ ordinal: ++frame.next, ...values }));
}
function record(frame: Frame, channel: Outcome["channel"], method: string, params: unknown, invoke: () => unknown): Promise<unknown> {
  if (frame.closing || frame.outcomes.length >= 64) return Promise.reject(quarantine("late-call-or-rpc-cap"));
  const item: Outcome = { ordinal: ++frame.next, channel, method, params: undefined, terminal: "pending" };
  frame.outcomes.push(item);
  let request: Promise<unknown>;
  try { item.params = copy(params); request = Promise.resolve(invoke()); }
  catch (error) {
    item.terminal = "sync-threw"; item.error = error; item.settled = ++frame.next;
    frame.unexpected.push(error); Object.freeze(item);
    throw error;
  }
  frame.pending.add(request);
  void request.then((result) => {
    frame.pending.delete(request);
    try { item.result = copy(result); } catch (error) { item.error = error; frame.unexpected.push(error); }
    item.terminal = "fulfilled"; item.settled = ++frame.next; Object.freeze(item);
  }, (error: unknown) => {
    frame.pending.delete(request); item.error = error; item.terminal = "rejected"; item.settled = ++frame.next;
    frame.unexpected.push(error); Object.freeze(item);
  });
  return request;
}

function writeLedger(frame: Frame, terminal: "retired" | "uncertain") {
  const root = process.env.TERNO_FORWARD_REMAINING_RUN;
  if (!root || frame.ledgerWritten) return;
  const errorImage = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message.slice(0, 2048), stack: error.stack?.slice(0, 4096) } : { primitive: String(error).slice(0, 2048) };
  const image = { title: frame.title, terminal, unavailable: ownership.unavailable, events: frame.events,
    outcomes: frame.outcomes.map((item) => ({ ...item, ...(item.error !== undefined ? { error: errorImage(item.error) } : {}) })),
    pending: frame.pending.size, unexpected: frame.unexpected.map(errorImage) };
  writeFileSync(join(root, `presentation-fixture-${process.pid}-${process.hrtime.bigint()}.json`), JSON.stringify(image), { flag: "wx", mode: 0o600 });
  frame.ledgerWritten = true;
}

type AuxMethod = "threads.list" | "compose.warm" | "compose.suggestRecipients" | "compose.recipientInitials";
type AuxResults = { [M in AuxMethod]: ResultOf<M> };
// Independent closed fixture world: archived source cache, empty Inbox and learned-contact catalog.
const AUX_RESULTS = freeze({
  "threads.list": { items: [], nextCursor: null },
  "compose.warm": { ok: true },
  "compose.suggestRecipients": { items: [], ready: true },
  "compose.recipientInitials": {},
} satisfies AuxResults);
function isAuxMethod(method: string): method is AuxMethod {
  return Object.hasOwn(AUX_RESULTS, method);
}
function assertOwnedAccount(accountId: number | undefined): void {
  if (accountId !== undefined && accountId !== 1) throw new Error("Unknown presentation auxiliary account");
}
function auxiliaryCall(method: AuxMethod, params: unknown): AuxResults[AuxMethod] {
  if (method === "threads.list") {
    const p = contract[method].params.strict().parse(params);
    assertOwnedAccount(p.accountId);
    if (p.view !== "inbox" || p.limit !== 100 || p.categoryId !== undefined || p.unreadOnly !== undefined || p.filter !== undefined || p.cursor !== undefined || p.keepIds !== undefined) throw new Error("Unknown presentation list scope");
  } else if (method === "compose.recipientInitials") {
    const p = contract[method].params.strict().parse(params); assertOwnedAccount(p.accountId);
  } else if (method === "compose.suggestRecipients") {
    const p = contract[method].params.strict().parse(params); assertOwnedAccount(p.accountId);
    if (p.limit !== 6) throw new Error("Unknown presentation suggestion limit");
  } else contract["compose.warm"].params.strict().parse(params);
  return AUX_RESULTS[method];
}
export function observePresentationRpc(method: string, params: unknown, invoke: () => unknown) {
  const frame = ownership.active;
  if (!frame) return invoke();
  if (isAuxMethod(method)) return record(frame, "aux", method, params, () => auxiliaryCall(method, params));
  if (method === "drafts.sourceContext") return record(frame, "rpc", method, params, invoke);
  return record(frame, "rpc", method, params, () => { throw new Error(`RPC outside the closed presentation-two scope: ${method}`); });
}

export function assertPresentationFixtureAvailable() {
  if (ownership.unavailable || ownership.active) quarantine("prior-or-overlapping-owner");
}
export function beginPresentationRpcFixture() {
  if (ownership.unavailable) quarantine("prior-owner-uncertain");
  if (ownership.active || !ownership.current || !ownership.rawSet) quarantine("overlapping-or-uninitialized-owner");
  const frame: Frame = { previous: ownership.current, closing: false, outcomes: [], pending: new Set(), unexpected: [], events: [], next: 0, stops: [], objects: new WeakMap(), objectSeq: 0, title: expect.getState().currentTestName ?? "unknown" };
  const rows = new Map<number, Draft>(); let nextId = 100;
  const knownSources = new Map<number, number>([[3, 7]]);
  const snapshot = (id: number, generation: string, revision: number, fields: Omit<Draft, "id" | "generation" | "revision">): Draft => copy({ id, generation, revision, ...fields });
  const writer: Call = (method, params) => record(frame, "model", method, params, () => {
    if (method === "drafts.delete") {
      const p = contract[method].params.parse(params), row = rows.get(p.id);
      if (!row || row.generation !== p.generation) throw new Error("Unexpected fixture delete target");
      rows.delete(p.id); return { ok: true } satisfies ResultOf<"drafts.delete">;
    }
    const p = contract["drafts.save"].params.parse(params), previous = p.id === undefined ? undefined : rows.get(p.id);
    if (p.id !== undefined && (!previous || previous.generation !== p.generation || previous.revision !== p.baseRevision)) throw new Error("Unexpected fixture save identity/baseRevision");
    const id = previous?.id ?? ++nextId, generation = previous?.generation ?? `presentation-${id}`;
    const source = p.mode === "forward" ? p.forwardOfMessageId : p.mode === "reply" || p.mode === "replyAll" ? p.inReplyToMessageId : null;
    const association = source == null ? null : knownSources.get(source);
    if (p.showSourceContext && source != null && (association === undefined || (p.threadId != null && p.threadId !== association))) throw new Error("Unknown or mismatched fixture source association");
    if (!previous && rows.size >= 8) throw new Error("Fixture row cap");
    const result: Draft = snapshot(id, generation!, (previous?.revision ?? 0) + 1, {
      format: 2, accountId: p.accountId, threadId: p.threadId ?? null, mode: p.mode ?? "new",
      to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, subjectEdited: p.subjectEdited ?? false,
      bodyText: p.bodyText, bodyHtml: p.bodyHtml, attachments: p.attachments ?? [], quotedText: p.quotedText ?? "", includeQuote: p.includeQuote ?? false,
      inReplyToMessageId: p.inReplyToMessageId ?? null, forwardOfMessageId: p.forwardOfMessageId ?? null,
      showSourceContext: p.showSourceContext ?? false, presentationThreadId: p.showSourceContext ? association ?? p.threadId ?? null : null,
      uiState: p.uiState ?? "open", updatedAt: Date.now(),
    });
    rows.set(id, result); return result;
  });
  ownership.active = frame;
  const owner: Owner = { call: writer, clock: frame.previous.clock, frame };
  ownership.rawSet(writer, owner.clock); ownership.current = owner;
  const ordinal = (value: object | null | undefined) => {
    if (!value) return 0;
    let n = frame.objects.get(value); if (!n) { n = ++frame.objectSeq; frame.objects.set(value, n); } return n;
  };
  return {
    modelCall: writer,
    get outcomes(): readonly Readonly<Outcome>[] { return frame.outcomes; },
    get events(): readonly Stage[] { return frame.events; },
    seed() {
      if (frame.outcomes.length || rows.size) throw new Error("Fixture seed must precede every event");
      rows.set(81, snapshot(81, "stable", 4, {
        format: 2, accountId: 1, threadId: null, mode: "reply", to: [], cc: [], bcc: [], subject: "", subjectEdited: false,
        bodyText: "exact authored work", bodyHtml: "", attachments: [], quotedText: "", includeQuote: false,
        inReplyToMessageId: 3, forwardOfMessageId: null, showSourceContext: true, presentationThreadId: 7, uiState: "open", updatedAt: 0,
      }));
    },
    observe(drafts: typeof import("~/lib/drafts"), app: typeof import("~/state/app"), pending: () => boolean, key: string) {
      const image = (d: LocalDraft | undefined) => ({ target: ordinal(d), validId: typeof d?.id === "number", validGeneration: typeof d?.generation === "string", revision: d?.revision ?? -1, localRev: d?.localRev ?? -1, savedRev: d?.savedRev ?? -1, mode: d?.mode ?? "missing", status: d?.status ?? "missing" });
      frame.stops.push(drafts.useDrafts.subscribe((state, previous) => event(frame, { kind: "draft", state: ordinal(state), previous: ordinal(previous), ...image(state.drafts[key]), pending: pending() })));
      frame.stops.push(app.useApp.subscribe((state) => event(frame, { kind: "app", seq: state.draftFocus?.seq ?? -1, request: ordinal(state.draftFocus), pending: pending() })));
      const focus = (e: FocusEvent) => {
        const target = e.target instanceof Element ? e.target : null;
        event(frame, { kind: "focus", to: target?.matches('[data-testid="compose-to"]') ?? false, reader: target?.matches('[data-testid="reader"]') ?? false, connected: target?.isConnected ?? false, pending: pending() });
      };
      document.addEventListener("focusin", focus, true); frame.stops.push(() => document.removeEventListener("focusin", focus, true));
    },
    async retire(rendererCleanup: Promise<void>) {
      if (ownership.active !== frame || ownership.current?.frame !== frame) quarantine("successor-owner-preserved");
      const closingOwner = ownership.current; let timer: ReturnType<typeof nativeSetTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          try { await rendererCleanup; } catch (error) { frame.unexpected.push(error); }
          while (frame.pending.size) await Promise.allSettled(frame.pending);
        })(), new Promise<never>((_, reject) => { timer = nativeSetTimeout(() => reject(new Error("Presentation cleanup native deadline")), 3000); })]);
      } catch (error) {
        frame.unexpected.push(error);
        try { writeLedger(frame, "uncertain"); } catch (outputError) { frame.unexpected.push(outputError); }
        quarantine("pending-not-terminal");
      }
      finally { if (timer) nativeClearTimeout(timer); }
      if (ownership.active !== frame || ownership.current !== closingOwner || frame.pending.size) quarantine("owner-changed-during-drain");
      frame.closing = true;
      for (const stop of frame.stops.splice(0)) stop();
      expect.soft(frame.outcomes.filter((o) => o.terminal === "pending")).toEqual([]);
      for (const outcome of frame.outcomes) {
        if (outcome.channel !== "rpc") continue;
        expect.soft(outcome.method).toBe("drafts.sourceContext");
        expect.soft(outcome.params).toEqual({ messageId: 3 });
        expect.soft(outcome.result).toEqual({ threadId: 7, accountId: 1 });
      }
      expect.soft(frame.unexpected).toEqual([]);
      try { writeLedger(frame, "retired"); } catch (error) { frame.unexpected.push(error); quarantine("ledger-output-failed"); }
      // Every channel remains subject to the post-drain unexpected-error assertion.
      ownership.rawSet!(frame.previous.call, frame.previous.clock); ownership.current = frame.previous; ownership.active = undefined;
      rows.clear();
    },
  };
}

export async function defaultPresentationRpc(method: string, params: unknown): Promise<unknown> {
  if (method === "drafts.sourceContext") {
    const p = contract[method].params.parse(params);
    if (p.messageId !== 3) throw new Error("Unknown presentation source");
    return { threadId: 7, accountId: 1 } satisfies ResultOf<"drafts.sourceContext">;
  }
  throw new Error(`Unexpected presentation fixture RPC: ${method}`);
}

// Explicit two-scenario option: importing this helper alone never starts a frame/model.
export const presentationOwnedRpc = Object.freeze({
  available: assertPresentationFixtureAvailable,
  begin: beginPresentationRpcFixture,
  call: observePresentationRpc,
  defaultCall: defaultPresentationRpc,
});
