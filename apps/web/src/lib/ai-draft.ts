import { formatAddressList, parseAddressList, WRITING_ONE_OFF_MAX, type AiComposeResult, type AiErrorKind, type AiIntentResult, type IntentPerson, type IntentQuestion } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { controllerFor, focusBody } from "~/components/composer/controller";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { loadThread, useThreads } from "~/state/threads";
import { errorHelp, writingTarget } from "./ai";
import { aiDraftHooks, useAiDraftUi, type AiDraftBadge } from "./ai-draft-state";
import { addressReply, composeLanding, leaveNewDraft, sendDraft } from "./compose";
import { focusSoon } from "./compose-focus-move";
import { draftCommands, draftKeyOf } from "./draft-commands";
import { authored, draftPresentationThread, editDraft, editDraftRecipients, flushDraft, forgetDraft, materialize, NO_AUTO, shownDraftKey, useDrafts, validateDraftPresentation, validRecipients, type LocalDraft } from "./drafts";
import { localized } from "./i18n";
import { currentPage, listLayout, openThread } from "./page";
import { snack } from "./snack";

/**
 * Plan 133 §10: a draft being written with AI, kept by draft key and outside any component, because pinning, collapsing
 * and switching threads all destroy the form while the stream goes on. Lazy: the entry chunk knows only
 * `lib/ai-draft-state.ts`. The stream's text stays out of the store (a preview takes it once per frame, with no render),
 * out of the document, its history and its autosave, until the one transaction that commits it.
 */

export type AiPhase =
  /** the field, waiting for words */
  | "input"
  /** working out where it goes (§5) */
  | "resolving"
  /** §5.2's questions */
  | "question"
  /** the first draft on a cloud provider says what it sends, once */
  | "telling"
  | "writing"
  /** the message it answers has no text here yet */
  | "waitingBody"
  /** finished, and it's the user's to place: notes, typing during the stream, a change of who it's for */
  | "choice"
  /** finished with no editor to go into: it goes in when the draft is opened again */
  | "held"
  | "strip"
  | "error"
  | "noProvider";

/** A logical snapshot of the draft (§10.4), since autosave bumps its `revision` mid-stream. */
export interface AiBinding {
  id: number | null;
  generation: string | undefined;
  accountId: number;
  to: string;
  cc: string;
  subject: string;
  mode: LocalDraft["mode"];
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
  files: string;
  doc: unknown;
  text: string;
  /** who it's being written for: "Written for Tom" if that changes */
  who: string;
}

type RunKind = "draft" | "notes" | "refine";

/** What a run was asked, so Try again asks the same. */
export interface RunSpec {
  kind: RunKind;
  instruction: string;
  previous?: string;
  notes?: string;
  /** Regenerate: replaces what the strip's run wrote, as a fresh take */
  regenerate?: boolean;
}

interface Run {
  requestId: string;
  spec: RunSpec;
  binding: AiBinding;
  needsSubject: boolean;
  /** the first of the stream has arrived */
  streaming: boolean;
  /** 8 s in: "Still writing…", or "Loading the model…" on a local one with no text yet */
  slow: boolean;
  /** the body changed under it: the result is a suggestion */
  typed: boolean;
  /** To, Cc, From or the subject moved: the result says who it was for */
  moved: boolean;
  /** what the strip was, for a refinement that ends without text */
  prior?: AiStrip;
}

export interface AiCommit {
  doc: unknown;
  /** the subject this filled, if it did */
  subject: string | null;
  /** what was there before, for an editor rebuilt without its history */
  before: { html: string; text: string };
}

export interface AiStrip {
  used: Extract<AiComposeResult, { status: "done" }>["used"];
  checks: Extract<AiComposeResult, { status: "done" }>["checks"];
  cutOff: boolean;
  oneTap: boolean;
  /** what the strip's Regenerate asks again */
  instruction: string;
  notes?: string;
  stack: AiCommit[];
}

export interface AiChoice {
  reason: "notes" | "typed";
  /** recipients moved while it was writing: "Written for Tom" */
  writtenFor: string | null;
  result: Extract<AiComposeResult, { status: "done" }>;
}

export interface AiError {
  message: string;
  help: string | null;
  kind: AiErrorKind | "other";
  retry: boolean;
  /** text that came before the failure: Insert keeps it */
  partial: boolean;
}

export interface AiSession {
  key: string;
  phase: AiPhase;
  instruction: string;
  /** seq: the row's field takes focus when it moves */
  focus: number;
  /** ⌘J made this draft: leaving the row with nothing done takes it away too */
  opened: boolean;
  /** the row asks who it's for */
  who: boolean;
  question: IntentQuestion | null;
  fromAccountId: number | null;
  /** `parseIntent` couldn't say, so the route stayed as it was */
  confirmFailed: boolean;
  /** "Looking up contacts…" */
  lookingUp: boolean;
  /** "Include everyone (3)", on a reply narrowed to one person */
  everyone: number;
  run: Run | null;
  lastSpec: RunSpec | null;
  choice: AiChoice | null;
  held: { how: "replace" | "below"; result: Extract<AiComposeResult, { status: "done" }>; spec: RunSpec; prior: AiStrip | undefined; needsSubject: boolean } | null;
  error: AiError | null;
  strip: AiStrip | null;
  /** a send was stopped here: the row offers the choice; `sendAt` is what it was asked to do */
  guard: { sendAt: number | undefined } | null;
  /** what a screen reader hears: never the deltas */
  live: string;
}

export const useAiDraft = create<{ sessions: Readonly<Record<string, AiSession>> }>(() => ({ sessions: {} }));

const memory: { last: string } = { last: "" };

// ── the stream's text: per draft, outside the store

interface Stream {
  text: string;
  listeners: Set<() => void>;
  frame: number;
}
const streams = new Map<string, Stream>();
const requests = new Map<string, string>();

function streamOf(key: string): Stream {
  let stream = streams.get(key);
  if (!stream) streams.set(key, (stream = { text: "", listeners: new Set(), frame: 0 }));
  return stream;
}

export const previewText = (key: string): string => streams.get(key)?.text ?? "";

export function subscribePreview(key: string, listener: () => void): () => void {
  const { listeners } = streamOf(key);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Batched per frame: deltas arrive about every 30 ms, on a backend's clock. */
function paint(stream: Stream) {
  if (stream.frame) return;
  const flush = () => {
    stream.frame = 0;
    for (const l of stream.listeners) l();
  };
  stream.frame = requestAnimationFrame(flush);
}

function clearStream(key: string) {
  const stream = streams.get(key);
  if (!stream) return;
  if (stream.frame) cancelAnimationFrame(stream.frame);
  stream.frame = 0;
  stream.text = "";
  for (const l of stream.listeners) l();
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  client.on("aiCompose", ({ requestId, text }) => {
    const key = requests.get(requestId);
    if (!key) return;
    const s = useAiDraft.getState().sessions[key];
    if (s?.run?.requestId !== requestId) return;
    const stream = streamOf(key);
    stream.text += text;
    paint(stream);
    if (!s.run.streaming) update(key, { run: { ...s.run, streaming: true } });
  });
}

/** Where the preview stands, if it shows at all: over the empty body, over the text it will replace, or under what's there. */
export function previewMode(s: AiSession | undefined): "overlay" | "refine" | "below" | null {
  if (!s?.run) return null;
  const showing = s.phase === "writing" || s.phase === "waitingBody" || s.phase === "choice" || (s.phase === "error" && s.error?.partial === true);
  if (!showing) return null;
  if (s.run.typed || s.run.spec.kind === "notes" || s.phase === "choice") return "below";
  if (s.run.spec.kind === "refine") return s.run.streaming ? "refine" : null;
  return "overlay";
}

// ── the store

const BADGE: Partial<Record<AiPhase, AiDraftBadge>> = { writing: "writing", waitingBody: "writing", resolving: "writing", choice: "ready", held: "ready" };

function publishBadges() {
  const rows: Record<string, AiDraftBadge> = {};
  for (const [key, s] of Object.entries(useAiDraft.getState().sessions)) rows[key] = BADGE[s.phase] ?? "open";
  useAiDraftUi.setState({ rows });
}

function update(key: string, patch: Partial<AiSession>) {
  const s = useAiDraft.getState().sessions[key];
  if (!s) return;
  useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: { ...s, ...patch } } }));
  if (patch.phase !== undefined) publishBadges();
}

const session = (key: string): AiSession | undefined => useAiDraft.getState().sessions[key];
const draftOf = (key: string): LocalDraft | undefined => useDrafts.getState().drafts[key];

function remove(key: string, endCompose = true) {
  const s = session(key);
  if (!s) return;
  const { [key]: _gone, ...rest } = useAiDraft.getState().sessions;
  useAiDraft.setState({ sessions: rest });
  publishBadges();
  clearStream(key);
  streams.delete(key);
  stopWaiting(key);
  clearSlow(key);
  if (endCompose && s.lastSpec) void quietly(() => client.call("ai.composeEnd", { session: sessionId(key) }));
}

const sessionId = (key: string) => key.slice(0, 64);

async function quietly(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch {
    /* it ended either way */
  }
}

function newSession(key: string, o: { opened: boolean; phase: AiPhase }): AiSession {
  return { key, phase: o.phase, instruction: "", focus: 1, opened: o.opened, who: false, question: null, fromAccountId: null, confirmFailed: false, lookingUp: false, everyone: 0, run: null, lastSpec: null, choice: null, held: null, error: null, strip: null, guard: null, live: "" };
}

// ── the row opens

const aiSettings = () => getApp().settings?.ai;

const threadInFront = (): number | null => {
  const app = getApp();
  if (app.selectedId === null || app.scope !== null || app.checked.size >= 2 || app.compose) return null;
  return listLayout() && currentPage() === "list" ? null : app.selectedId;
};

function rowFieldFocused(key: string): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.testid === "ai-row-input" && draftKeyOf(active) === key;
}

function showRow(key: string, opened: boolean) {
  const s = session(key);
  if (!s) {
    const ready = writingTarget(aiSettings()).ready;
    useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: newSession(key, { opened, phase: ready ? "input" : "noProvider" }) } }));
    publishBadges();
    return;
  }
  // ⌘J again in the field: it closes, as it opened
  if (s.phase === "input" && !s.strip && !s.instruction && rowFieldFocused(key)) return closeRow(key);
  if (s.phase === "strip") return update(key, { phase: "input", instruction: "", focus: s.focus + 1, who: false });
  update(key, { focus: s.focus + 1 });
}

/** ⌘J, the buttons and the palette: the row on the draft named, or the one in front of the user, or the draft §5.2 opens. */
export async function openRow(o: { key?: string; threadId?: number } = {}): Promise<void> {
  listen();
  const app = getApp();
  const key = o.key ?? draftKeyOf(document.activeElement) ?? app.compose?.key;
  if (key) return showRow(key, false);
  const threadId = o.threadId ?? threadInFront();
  const onLanded = (landing: { kind: string; key: string }) => showRow(landing.key, landing.kind === "created");
  if (threadId !== null) {
    if (listLayout() && currentPage() === "list") openThread(threadId);
    const drafts = useDrafts.getState().drafts;
    const existing = shownDraftKey(drafts, threadId, getApp().draftShown);
    await composeLanding(existing ? drafts[existing]!.mode : "reply", threadId, 0, undefined, undefined, { target: "ai", onLanded });
    return;
  }
  await composeLanding("new", null, 0, undefined, undefined, { target: "ai", onLanded });
}

export function setInstruction(key: string, instruction: string) {
  update(key, { instruction: instruction.slice(0, WRITING_ONE_OFF_MAX), who: false });
}

/** ↑ in an empty field. */
export function recallInstruction(key: string): boolean {
  if (!memory.last) return false;
  update(key, { instruction: memory.last });
  return true;
}

/** Back to the text, from the row or from nowhere: someone who moved on to To, or to the list, stays there. */
function focusEditor(key: string) {
  const active = document.activeElement;
  if (active && active !== document.body && !rowOwns(active, key) && active.getAttribute("data-testid") !== "compose-body") return;
  focusBody(key, "keep");
}
const rowOwns = (el: Element, key: string) => el.closest(`[data-ai-row="${CSS.escape(key)}"]`) !== null;

/** The row goes; the strip comes back if it was opened over one; the caret goes back to the text. */
export function closeRow(key: string) {
  const s = session(key);
  if (!s) return;
  const d = draftOf(key);
  if (s.strip) {
    update(key, { phase: "strip", instruction: "", question: null, error: null, who: false, confirmFailed: false, lookingUp: false });
    return focusEditor(key);
  }
  const untouched = s.opened && d !== undefined && !authored(d);
  remove(key);
  if (untouched) {
    if (d.mode === "new") draftCommands(key)?.close?.();
    else {
      forgetDraft(key);
      focusSoon("[data-testid=quick-reply]", null, 12);
    }
    return;
  }
  focusEditor(key);
}

// ── §5: where it goes

function telling(): { provider: string; key: string } | null {
  const target = writingTarget(aiSettings());
  if (target.local) return null;
  const key = `terno:ai-draft-told:${target.provider}`;
  try {
    return globalThis.localStorage?.getItem(key) ? null : { provider: target.provider, key };
  } catch {
    return null;
  }
}

/** The first-use line: read, and said once. */
export function acknowledgeTold(key: string) {
  const line = telling();
  try {
    if (line) globalThis.localStorage?.setItem(line.key, "1");
  } catch {
    /* a private window: it says so again next time */
  }
  void submit(key);
}

function surfaceOf(d: LocalDraft) {
  const thread = threadOf(d);
  // a reply Terno filled in isn't a choice of the user's: the conversation it's on is the surface
  if ((d.mode === "reply" || d.mode === "replyAll") && thread !== null && !authored(d)) return { kind: "thread" as const, threadId: thread };
  const recipients = validRecipients(d.toText);
  if (d.mode === "new" && !recipients.length && !authored(d)) return { kind: "list" as const };
  return { kind: "draft" as const, recipients };
}

const threadOf = (d: LocalDraft): number | null => draftPresentationThread(d) ?? d.threadId;

/** The row's Enter. */
export async function submit(key: string): Promise<void> {
  const s = session(key);
  const d = materialize(key);
  if (!s || !d) return;
  const instruction = s.instruction.trim();
  if (!writingTarget(aiSettings()).ready) return update(key, { phase: "noProvider" });
  if (instruction) memory.last = instruction;
  if (telling()) return update(key, { phase: "telling", focus: s.focus + 1 });
  update(key, { error: null, confirmFailed: false, question: null, who: false });
  // ⌘J over the strip: free-form refining, instant to assemble and cheap
  if (s.strip) return instruction ? startRun(key, { kind: "refine", instruction, previous: bodyNow(key) }) : refine(key, "regenerate");
  if (!instruction) {
    if (d.mode === "new" && !validRecipients(d.toText).length) return askWho(key);
    return startRun(key, runFor(key, ""));
  }
  await resolve(key, instruction, d);
}

function runFor(key: string, instruction: string): RunSpec {
  const notes = bodyNow(key);
  return notes.trim() ? { kind: "notes", instruction, notes } : { kind: "draft", instruction };
}

function askWho(key: string) {
  const s = session(key);
  if (!s) return;
  update(key, { phase: "input", who: true, live: t("aiDraft.who"), lookingUp: false });
  focusSoon(`[data-draft-key="${CSS.escape(key)}"] [data-testid=compose-to]`, null, 12);
}

async function resolve(key: string, instruction: string, d: LocalDraft) {
  const surface = surfaceOf(d);
  const asked = () => { const now = session(key); return now?.phase === "resolving" && now.instruction.trim() === instruction; };
  update(key, { phase: "resolving", lookingUp: false });
  const accountId = surface.kind === "list" ? getApp().accountId ?? undefined : d.accountId;
  let result: AiIntentResult;
  try {
    result = await client.call("ai.resolveIntent", { requestId: globalThis.crypto.randomUUID(), instruction, surface, ...(accountId !== undefined ? { accountId } : {}) });
    if (!asked()) return;
    if (result.decision.kind === "wait") {
      // "not ready" is never "no such person": it answers when the index is warm, with nothing to poll
      update(key, { lookingUp: true });
      result = await client.call("ai.resolveIntent", { requestId: globalThis.crypto.randomUUID(), instruction, surface, waitForContacts: true, ...(accountId !== undefined ? { accountId } : {}) });
      if (!asked()) return;
    }
  } catch (error) {
    if (asked()) failed(key, error);
    return;
  }
  update(key, { lookingUp: false, confirmFailed: result.confirmFailed, fromAccountId: result.fromAccountId });
  const { decision } = result;
  if (decision.kind === "ask") {
    if (decision.question.type === "who") return askWho(key);
    update(key, { phase: "question", question: decision.question, live: t("aiDraft.question.live"), focus: (session(key)?.focus ?? 0) + 1 });
    return;
  }
  if (decision.kind !== "route") {
    // a `wait` from the second call: the index can't be built here, so nobody was named
    if (surface.kind === "list") return askWho(key);
    return startRun(key, runFor(key, instruction));
  }
  const { route } = decision;
  switch (route.type) {
    case "reply": {
      const thread = threadOf(d);
      if (route.to && thread !== null) await addressReply(key, thread, route.to);
      if (!asked()) return;
      update(key, { everyone: route.to && route.includeEveryone > 1 ? route.includeEveryone : 0 });
      return startRun(key, runFor(key, instruction));
    }
    case "new":
    case "fill-draft":
      addRecipient(key, route.to);
      useFrom(key, result.fromAccountId);
      return startRun(key, runFor(key, instruction));
    case "keep-draft":
      if (!validRecipients(d.toText).length) return askWho(key);
      return startRun(key, runFor(key, instruction));
  }
}

function addRecipient(key: string, person: IntentPerson) {
  const d = draftOf(key);
  if (!d) return;
  const email = person.address;
  const list = parseAddressList(d.toText);
  if (list.some((a) => a.email.toLowerCase() === email.toLowerCase())) return;
  editDraftRecipients(key, "to", formatAddressList([...list, { name: person.name, email }]), [email.toLowerCase()]);
}

function useFrom(key: string, accountId: number | null) {
  const d = draftOf(key);
  if (accountId !== null && d && d.accountId !== accountId && getApp().accounts.some((a) => a.id === accountId)) editDraft(key, { accountId });
}

export type AiAnswer = "forward" | "new" | "reply" | "add" | "justWrite";

/** A question's choice. Disclosure is the user's: nothing is quoted, attached or addressed until here. */
export async function answer(key: string, choice: AiAnswer): Promise<void> {
  const s = session(key);
  const d = draftOf(key);
  if (!s?.question || !d || s.question.type === "who") return;
  const { question, fromAccountId } = s;
  const instruction = s.instruction.trim();
  const to = question.to;
  const carry = (next: string) => {
    useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [next]: { ...newSession(next, { opened: true, phase: "resolving" }), instruction, fromAccountId, confirmFailed: s.confirmFailed } } }));
    publishBadges();
  };
  if (choice === "add") addRecipient(key, to);
  if (choice === "add" || choice === "justWrite") return startRun(key, runFor(key, instruction));
  if (choice === "forward") {
    const thread = threadOf(d);
    if (thread === null) return;
    update(key, { question: null, phase: "resolving" });
    const landed = await composeLanding("forward", thread, 0, undefined, undefined, { target: "ai" });
    if (landed.kind === "none") return update(key, { phase: "input" });
    if (landed.key !== key) {
      remove(key, false);
      carry(landed.key);
    }
    addRecipient(landed.key, to);
    return startRun(landed.key, runFor(landed.key, instruction));
  }
  if (choice === "new") {
    // from the list the draft is already this new message; from a conversation, it's a new one, and the empty reply goes
    if (d.mode === "new") {
      addRecipient(key, to);
      useFrom(key, fromAccountId);
      return startRun(key, runFor(key, instruction));
    }
    const prefill = () => ({ toText: formatAddressList([{ name: to.name, email: to.address }]), auto: NO_AUTO });
    const wasEmpty = !authored(d);
    remove(key, false);
    const landed = await composeLanding("new", null, 0, prefill, fromAccountId ?? d.accountId, { target: "ai", onLanded: (l) => carry(l.key) });
    if (landed.kind === "none") return;
    if (wasEmpty) forgetDraft(key);
    return startRun(landed.key, { kind: "draft", instruction });
  }
  // Reply on the recent thread
  if (question.type !== "new-or-reply") return;
  const threadId = question.thread.threadId;
  remove(key, false);
  if (d.mode === "new" && !authored(d)) {
    if (getApp().compose?.key === key) leaveNewDraft();
    else forgetDraft(key);
  }
  openThread(threadId);
  const landed = await composeLanding("reply", threadId, 0, undefined, undefined, { target: "ai", onLanded: (l) => carry(l.key) });
  if (landed.kind === "none") return;
  await addressReply(landed.key, threadId, to);
  return startRun(landed.key, runFor(landed.key, instruction));
}

// ── a run

function bodyNow(key: string): string {
  const c = controllerFor(key);
  return c ? c.snapshot().text : materialize(key)?.bodyText ?? "";
}

const filesOf = (d: LocalDraft) => (d.mode === "forward" ? "" : (d.attachments ?? []).map((a) => a.filename).join("\n"));
const addresses = (text: string) => parseAddressList(text).map((a) => a.email.toLowerCase()).join(",");

function bind(key: string, d: LocalDraft): AiBinding {
  const c = controllerFor(key);
  return { id: d.id, generation: d.generation, accountId: d.accountId, to: addresses(d.toText), cc: addresses(d.ccText), subject: d.subject, mode: d.mode, inReplyToMessageId: d.inReplyToMessageId, forwardOfMessageId: d.forwardOfMessageId, files: filesOf(d), doc: c?.docToken() ?? null, text: bodyNow(key), who: firstName(d.toText) };
}

/** To, Cc, From, the subject, where it's answering or the files: what it was written for isn't this any more. */
export function fieldsMoved(b: AiBinding, d: LocalDraft): boolean {
  return b.accountId !== d.accountId || b.to !== addresses(d.toText) || b.cc !== addresses(d.ccText) || b.subject !== d.subject || b.mode !== d.mode || b.inReplyToMessageId !== d.inReplyToMessageId || b.forwardOfMessageId !== d.forwardOfMessageId || b.files !== filesOf(d);
}

function firstName(toText: string): string {
  const first = parseAddressList(toText)[0];
  if (!first) return "";
  return (first.name || first.email.split("@")[0] || "").split(/\s+/)[0] ?? "";
}

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const STILL_WRITING_MS = 8000;
const slowTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearSlow(key: string) {
  const timer = slowTimers.get(key);
  if (timer) clearTimeout(timer);
  slowTimers.delete(key);
}

function startRun(key: string, spec: RunSpec): void {
  const s = session(key);
  const d = materialize(key);
  if (!s || !d) return;
  listen();
  const requestId = globalThis.crypto.randomUUID();
  const needsSubject = d.mode === "new" && !d.subject.trim();
  const binding = bind(key, d);
  clearStream(key);
  requests.set(requestId, key);
  const prior = s.run?.prior ?? s.strip ?? undefined;
  update(key, {
    phase: "writing",
    question: null,
    choice: null,
    error: null,
    who: false,
    guard: null,
    strip: null,
    lastSpec: spec,
    live: t("aiDraft.live.writing"),
    run: { requestId, spec, binding, needsSubject, streaming: false, slow: false, typed: false, moved: false, ...(prior ? { prior } : {}) },
  });
  controllerFor(key)?.dismissGhost();
  focusEditor(key);
  clearSlow(key);
  slowTimers.set(key, setTimeout(() => {
    const now = session(key);
    if (now?.run?.requestId === requestId) update(key, { run: { ...now.run, slow: true } });
  }, STILL_WRITING_MS));
  const to = validRecipients(d.toText);
  const cc = validRecipients(d.ccText);
  const thread = threadOf(d);
  void client.call("ai.compose", {
    requestId,
    session: sessionId(key),
    accountId: d.accountId,
    kind: d.mode === "new" || d.mode === "forward" ? "new" : "reply",
    ...(thread !== null ? { threadId: thread } : {}),
    ...(d.mode !== "new" && d.mode !== "forward" && d.inReplyToMessageId !== null ? { answeringMessageId: d.inReplyToMessageId } : {}),
    to,
    cc,
    subject: d.subject,
    needsSubject,
    instruction: spec.instruction,
    ...(spec.notes !== undefined ? { draft: spec.notes } : {}),
    ...(spec.previous !== undefined ? { previousDraft: spec.previous } : {}),
    attachments: (d.attachments ?? []).map((a) => a.filename),
    timezone: timezone(),
  }).then(
    (result) => {
      requests.delete(requestId);
      if (session(key)?.run?.requestId === requestId) finished(key, result);
    },
    (error: unknown) => {
      requests.delete(requestId);
      if (session(key)?.run?.requestId === requestId) failed(key, error);
    },
  );
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function finished(key: string, result: AiComposeResult) {
  const s = session(key);
  const run = s?.run;
  if (!s || !run) return;
  clearSlow(key);
  if (result.status === "waitingBody") return waitForBody(key, result.messageId);
  const d = draftOf(key);
  if (!d) return remove(key);
  const stream = streamOf(key);
  stream.text = result.text;
  if (stream.frame) cancelAnimationFrame(stream.frame);
  stream.frame = 0;
  for (const l of stream.listeners) l();
  if (!result.text.trim()) return failed(key, { message: t("errors.ai.draftFailed") });
  const moved = fieldsMoved(run.binding, d);
  const unchanged = bodyNow(key) === run.binding.text;
  if (run.spec.kind === "notes" || moved || !unchanged) {
    const writtenFor = moved && run.binding.to !== addresses(d.toText) ? run.binding.who || null : null;
    update(key, { phase: "choice", choice: { reason: run.spec.kind === "notes" && unchanged && !moved ? "notes" : "typed", writtenFor, result }, live: t("aiDraft.live.ready", { count: wordCount(result.text) }), run: { ...run, typed: true } });
    return;
  }
  // the draft can't change right now (the mailbox is handing over): it waits for a choice, never lost
  if (!commit(key, "replace", result, run.spec, run.prior, run.needsSubject)) update(key, { phase: "choice", choice: { reason: "typed", writtenFor: null, result }, run: { ...run, typed: true } });
}

function failed(key: string, error: unknown) {
  const s = session(key);
  if (!s) return;
  clearSlow(key);
  const e = (error ?? {}) as { code?: string; message?: string; details?: { aiErrorKind?: AiErrorKind }; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
  const kind = e.details?.aiErrorKind;
  const prior = s.run?.prior ?? null;
  // stopped by a provider or model change, or the window closing: nothing was written
  if (e.code === "CANCELLED" || kind === "cancelled") {
    clearStream(key);
    return update(key, { phase: prior ? "strip" : "input", strip: prior, run: null });
  }
  if (kind === "not_configured") {
    clearStream(key);
    return update(key, { phase: "noProvider", run: null, strip: prior });
  }
  const refused = kind === "refused";
  const message = refused ? t("aiDraft.refused") : localized(e.message ?? "", e.i18n);
  const partial = !refused && kind !== "unsupported" && previewText(key).trim() !== "";
  if (!partial) clearStream(key);
  const ai = aiSettings();
  const help = !refused && ai ? errorHelp(kind, ai) : null;
  update(key, { phase: "error", error: { message, help, kind: kind ?? "other", retry: e.code !== "NOT_FOUND" && kind !== "unsupported", partial }, live: message, strip: partial ? s.strip : prior, run: partial ? s.run : null });
}

// §6.2: never a real answer from a snippet: it waits for the text
const waiting = new Map<string, () => void>();
function stopWaiting(key: string) {
  waiting.get(key)?.();
  waiting.delete(key);
}

function waitForBody(key: string, messageId: number) {
  const s = session(key);
  const d = draftOf(key);
  if (!s || !d) return;
  const spec = s.lastSpec;
  const thread = threadOf(d);
  update(key, { phase: "waitingBody", live: t("aiDraft.downloading") });
  stopWaiting(key);
  if (thread === null || !spec) return;
  const off = useThreads.subscribe((state) => {
    const message = state.details.get(thread)?.messages.find((m) => m.id === messageId);
    if (message?.bodyState !== "full") return;
    stopWaiting(key);
    if (session(key)?.phase === "waitingBody") startRun(key, spec);
  });
  waiting.set(key, off);
  // the reader is fetching it if it's open; this asks for the thread as it is now
  void loadThread(thread, true);
}

/** Esc and the row's Stop: it ends, nothing is written, the strip comes back if there was one. */
export function stop(key: string) {
  const s = session(key);
  if (!s) return;
  cancel(s);
  clearStream(key);
  stopWaiting(key);
  const prior = s.run?.prior;
  const c = controllerFor(key);
  if (prior && (!c || c.docToken() === prior.stack[prior.stack.length - 1]?.doc)) {
    update(key, { phase: "strip", strip: prior, run: null, choice: null, error: null, guard: null, live: "" });
    return focusEditor(key);
  }
  remove(key);
  focusEditor(key);
}

function cancel(s: AiSession) {
  const requestId = s.run?.requestId;
  if (requestId && requests.delete(requestId)) void quietly(() => client.call("ai.cancel", { requestId }));
  clearSlow(s.key);
}

// ── commit

function commit(key: string, how: "replace" | "below", result: Extract<AiComposeResult, { status: "done" }>, spec: RunSpec, prior: AiStrip | undefined, needsSubject: boolean): boolean {
  const c = controllerFor(key);
  if (!c) {
    // pinning, collapsing or another thread took the editor: it goes in when one is there
    update(key, { phase: "held", held: { how, result, spec, prior, needsSubject }, run: null, live: "" });
    return true;
  }
  const before = c.snapshot();
  const inserted = c.insertGenerated(result.text, how, result.checks.placeholders[0]);
  if (!inserted) {
    snack.error(t("aiDraft.cantInsert"));
    return false;
  }
  const d = draftOf(key);
  // never over a subject the user wrote (§10.3)
  let subject: string | null = null;
  if (needsSubject && result.subject && d && !d.subject.trim() && editDraft(key, { subject: result.subject, subjectEdited: true })) subject = result.subject;
  const stack = [...(prior?.stack ?? []), { doc: inserted.doc, subject, before }];
  // what the draft holds now, as a send will compare it: a replace is all of the text, an insert only what it wrote
  recordProvenance(key, how === "replace" ? c.snapshot().text : result.text);
  clearStream(key);
  const strip: AiStrip = { used: result.used, checks: result.checks, cutOff: result.stop === "length", oneTap: !spec.instruction && spec.kind === "draft", instruction: spec.instruction, ...(spec.notes !== undefined ? { notes: spec.notes } : {}), stack };
  update(key, { phase: "strip", strip, run: null, choice: null, held: null, error: null, guard: null, instruction: "", live: t("aiDraft.live.ready", { count: wordCount(result.text) }) });
  return true;
}

/** Replace, Insert below, Insert: the suggestion goes in, one undo step. */
export function place(key: string, how: "replace" | "below") {
  const s = session(key);
  if (s?.choice) {
    const spec = s.lastSpec ?? { kind: "draft" as const, instruction: s.instruction };
    if (commit(key, how, s.choice.result, spec, s.run?.prior, s.run?.needsSubject ?? false)) focusEditor(key);
  }
}

/** Connection lost mid-stream: what came is kept with Insert. */
export function placePartial(key: string) {
  const s = session(key);
  if (!s?.error?.partial) return;
  const text = previewText(key).trim();
  const empty = controllerFor(key)?.empty() ?? bodyNow(key) === "";
  const result: Extract<AiComposeResult, { status: "done" }> = { status: "done", text, subject: null, stop: "length", used: emptyUsed(), checks: { specifics: [], placeholders: [] } };
  if (commit(key, empty ? "replace" : "below", result, s.lastSpec ?? { kind: "draft", instruction: s.instruction }, s.run?.prior, false)) focusEditor(key);
}

function emptyUsed(): AiStrip["used"] {
  const target = writingTarget(aiSettings());
  return { levels: [], personFromOtherAccount: false, examples: 0, pastConversations: 0, threadMessages: 0, history: "none", learning: false, inboundSnippetOnly: false, language: "", provider: target.provider, model: aiSettings()?.model ?? "", reused: false };
}

/** Discard: the document never had it. */
export function discard(key: string) {
  const s = session(key);
  if (!s) return;
  clearStream(key);
  const prior = s.run?.prior;
  const c = controllerFor(key);
  if (prior && (!c || c.docToken() === prior.stack[prior.stack.length - 1]?.doc)) {
    update(key, { phase: "strip", strip: prior, run: null, choice: null, error: null, guard: null, live: "" });
    return focusEditor(key);
  }
  remove(key);
  focusEditor(key);
}

/** The draft is on screen again, with something waiting: now it goes in. */
export function commitHeld(key: string) {
  const s = session(key);
  if (s?.phase !== "held" || !s.held || !controllerFor(key)) return;
  commit(key, s.held.how, s.held.result, s.held.spec, s.held.prior, s.held.needsSubject);
}

// ── provenance (§8)

const provenance = new Map<string, Promise<void>>();

function recordProvenance(key: string, text: string) {
  const run = (async () => {
    // after the first save has given the draft its id
    await flushDraft(key, true);
    const d = draftOf(key);
    if (!d || d.id === null || !d.generation) return;
    try {
      await client.call("writing.commitGeneration", { accountId: d.accountId, draftId: d.id, draftGeneration: d.generation, address: parseAddressList(d.toText)[0]?.email ?? "", text });
    } catch {
      /* the draft stands; a send that can't be compared stays out of learning */
    }
  })();
  provenance.set(key, run);
  void run.finally(() => { if (provenance.get(key) === run) provenance.delete(key); });
}

// ── the strip

export const SHORTER = "Shorter. Keep every fact and commitment.";
export const WARMER = "Warmer, the way this person would be. Keep every fact and commitment.";

export function refine(key: string, how: "regenerate" | "shorter" | "warmer") {
  const s = session(key);
  if (!s?.strip) return;
  if (how === "regenerate") {
    const spec: RunSpec = s.strip.notes !== undefined ? { kind: "refine", instruction: s.strip.instruction, notes: s.strip.notes, regenerate: true } : { kind: "refine", instruction: s.strip.instruction, regenerate: true };
    return startRun(key, spec);
  }
  startRun(key, { kind: "refine", instruction: how === "shorter" ? SHORTER : WARMER, previous: bodyNow(key) });
}

/**
 * The strip's Undo: the text as ordinary undo would take it back, and a subject this filled, if nobody has edited it
 * since (§10.3). Under a refinement it goes back one version, and the strip stays for the one before.
 */
export function undoCommit(key: string) {
  const s = session(key);
  const top = s?.strip?.stack[s.strip.stack.length - 1];
  if (!s?.strip || !top) return;
  const c = controllerFor(key);
  const undone = c?.undoGenerated(top.doc);
  if (!undone) {
    // an editor rebuilt without its history: the same words, put back by hand, if they're still what it wrote
    const d = materialize(key);
    if (d && (c?.docToken() === top.doc || !c)) editDraft(key, { bodyHtml: top.before.html, bodyText: top.before.text });
  }
  const d = draftOf(key);
  if (top.subject !== null && d?.subject === top.subject) editDraft(key, { subject: "", subjectEdited: false });
  const stack = s.strip.stack.slice(0, -1);
  const under = stack[stack.length - 1];
  if (under && undone) {
    stack[stack.length - 1] = { ...under, doc: undone.doc };
    update(key, { strip: { ...s.strip, stack } });
    recordProvenance(key, bodyNow(key));
    return focusEditor(key);
  }
  remove(key);
  focusEditor(key);
}

/** Any change of the text: typing during a stream makes the result a suggestion; the strip lasts until the next keystroke. */
export function noteBody(key: string) {
  const s = session(key);
  const c = controllerFor(key);
  if (!s || !c) return;
  if (s.run && (s.phase === "writing" || s.phase === "waitingBody" || s.phase === "error")) {
    const typed = s.run.spec.kind === "draft" ? !c.empty() : c.docToken() !== s.run.binding.doc;
    if (typed !== s.run.typed) update(key, { run: { ...s.run, typed } });
    return;
  }
  const top = s.strip?.stack[s.strip.stack.length - 1];
  if (s.strip && top && c.docToken() !== top.doc) {
    if (s.phase === "strip") remove(key);
    else update(key, { strip: null });
  }
}

// ── send guard, Esc

const UNDECIDED: readonly AiPhase[] = ["writing", "waitingBody", "choice", "held"];
const undecided = (s: AiSession) => UNDECIDED.includes(s.phase) || (s.phase === "error" && s.error?.partial === true);

aiDraftHooks.blocksSend = (key, sendAt) => {
  const s = session(key);
  if (!s || !undecided(s)) return false;
  update(key, { guard: { sendAt }, live: t("aiDraft.guard.live"), focus: s.focus + 1 });
  return true;
};

aiDraftHooks.provenance = (key) => provenance.get(key) ?? Promise.resolve();

aiDraftHooks.busy = (key) => {
  const s = session(key);
  return !!s && (s.phase === "writing" || s.phase === "waitingBody" || s.phase === "choice" || s.phase === "resolving");
};

aiDraftHooks.escape = (key) => {
  const s = session(key);
  if (!s) return false;
  if (s.guard) {
    keepWriting(key);
    return true;
  }
  switch (s.phase) {
    case "writing":
    case "waitingBody":
      stop(key);
      return true;
    case "choice":
    case "held":
      discard(key);
      return true;
    case "strip":
      // nothing is pending: Esc is the form's, and the strip is there on return
      return false;
    case "resolving":
    case "input":
    case "question":
    case "telling":
    case "error":
    case "noProvider":
      if (s.error?.partial) discard(key);
      else closeRow(key);
      return true;
  }
};

/** The guard's other answer: nothing changes, and the text is where they were. */
export function keepWriting(key: string) {
  update(key, { guard: null, live: "" });
  focusEditor(key);
}

/** The guard: the suggestion goes and what's in the document is sent, the way it was asked. */
export function discardAndSend(key: string) {
  const s = session(key);
  if (!s?.guard) return;
  const { sendAt } = s.guard;
  cancel(s);
  remove(key);
  const commands = draftCommands(key);
  if (commands) commands.send(sendAt);
  else void sendDraft(key, sendAt);
}

/** Try again: what it was asked, with no automatic retry. */
export function retry(key: string) {
  const s = session(key);
  if (s?.lastSpec) startRun(key, s.lastSpec);
  else if (s) void submit(key);
}

/** "Include everyone (3)": the reply goes back to its whole conversation; what's being written stays. */
export async function includeEveryone(key: string): Promise<void> {
  const d = draftOf(key);
  const thread = d ? threadOf(d) : null;
  if (!d || thread === null) return;
  await composeLanding("replyAll", thread, 0, undefined, undefined, { target: "ai" });
  const s = session(key);
  const now = draftOf(key);
  if (!s || !now) return;
  // they asked for it knowingly: not a change that makes the text a suggestion
  update(key, { everyone: 0, ...(s.run ? { run: { ...s.run, binding: { ...s.run.binding, to: addresses(now.toText), cc: addresses(now.ccText), mode: now.mode, inReplyToMessageId: now.inReplyToMessageId } } } : {}) });
}

// ── coming back to the conversation

/**
 * Leaving a conversation retires its draft's place there (`expireDraftPresentation`), and only an explicit open brings
 * a draft back. A draft with its AI work in progress is what the user came back for (§10.4: "the strip shows on
 * return"), so arriving is that open: its source is checked as a strip's open checks it, and focus stays where it is.
 */
useApp.subscribe((state, previous) => {
  if (state.selectedId === previous.selectedId || state.selectedId === null) return;
  const threadId = state.selectedId;
  for (const key of Object.keys(useAiDraft.getState().sessions)) {
    const d = draftOf(key);
    if (!d?.presentationExpired || d.departedThreadId !== threadId) continue;
    const source = d.mode === "forward" ? d.forwardOfMessageId : d.mode === "new" ? null : d.inReplyToMessageId;
    if (source === null) continue;
    void (async () => {
      const context = await client.call("drafts.sourceContext", { messageId: source }).catch(() => null);
      const now = draftOf(key);
      if (context?.threadId === threadId && getApp().selectedId === threadId && now?.presentationExpired && session(key)) validateDraftPresentation(key, threadId);
    })();
  }
});

// ── what happens to the draft under it

useDrafts.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  for (const [key, s] of Object.entries(useAiDraft.getState().sessions)) {
    const before = previous.drafts[key], after = state.drafts[key];
    if (before === after) continue;
    // sent, discarded, scheduled: it cancels
    if (!after) {
      cancel(s);
      remove(key);
      continue;
    }
    const run = s.run;
    if (!run) continue;
    const b = run.binding;
    // Only the acknowledged first save's identity is adopted; anything else means this draft was superseded.
    if (b.id === null && after.id !== null) {
      run.binding = { ...b, id: after.id, generation: after.generation };
    } else if (after.recovery || (b.id !== null && (after.id !== b.id || after.generation !== b.generation))) {
      cancel(s);
      remove(key);
      continue;
    }
    const moved = fieldsMoved(run.binding, after);
    if (moved !== run.moved) update(key, { run: { ...run, moved } });
  }
});
