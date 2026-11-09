import { formatAddressList, parseAddressList, WRITING_ONE_OFF_MAX, type AiComposeResult, type AiErrorKind, type PreparedReply, type AiIntentResult, type IntentPerson, type IntentQuestion } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { controllerFor, focusBody } from "~/components/composer/controller";
import { aiErrorCopy, errorTarget } from "~/components/ai-error";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { loadThread, useThreads } from "~/state/threads";
import { draftingOffered, errorHelp, writingModel, writingTarget } from "./ai";
import { aiDraftHooks, canDraft, useAiDraftUi, type AiDraftBadge } from "./ai-draft-state";
import { addressReply, composeLanding, composeOpening, leaveNewDraft, sendDraft } from "./compose";
import { focusSoon } from "./compose-focus-move";
import { draftCommands, draftKeyOf } from "./draft-commands";
import { discardDraft, discardListeners, authored, draftPresentationThread, editDraft, editDraftRecipients, flushDraft, forgetDraft, loseDraftHome, materialize, NO_AUTO, shownDraftKey, unsaveDraft, useDrafts, validateDraftPresentation, validRecipients, type LocalDraft } from "./drafts";
import { localized } from "./i18n";
import { currentPage, listLayout, openThread } from "./page";
import { registerUndo, snack } from "./snack";

/**
 * Plan 133 §10: a draft being written with AI, kept by draft key and outside any component, because pinning, collapsing
 * and switching threads all destroy the form while the stream goes on. The stream's text stays out of the store (a preview takes it once per frame, with no render),
 * out of the document, its history and its autosave, until the one transaction that commits it.
 */

export type AiPhase =
  /** the field, waiting for words */
  | "input"
  /** working out where it goes (§5) */
  | "resolving"
  /** §5.2's questions */
  | "question"
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
export interface PreparedRef {
  threadId: number;
  rowId: string;
  revision: number;
}

export interface RunSpec {
  /** plan 144: these words came from a prepared reply */
  prepared?: PreparedRef;
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
  /** what was there before and what it made, for an editor rebuilt without its history */
  before: { html: string; text: string };
  /** plan 161: the document as the write found it, which the strip's Undo restores exactly after an edit */
  beforeDoc: unknown;
  /** plan 161: this version's own checks: going back to it brings them back (its gaps, its check line) */
  checks: AiStrip["checks"];
  /** plan 161, pass 2: what this version was asked (the strip shows it, Regenerate asks it again), and its notes */
  instruction?: string;
  notes?: string;
  /** plan 161, pass 3: this version is what came before a Stop */
  stopped?: boolean;
  /** plan 162 (after ai162-r02): what made this version, so Undo can say what it takes back */
  how?: CommitHow;
  text: string;
}

export type CommitHow = "draft" | "regenerate" | "shorter" | "warmer" | "rewrite";

/** What a run made, from what it was asked: a first draft, a fresh take, or a rewrite of the text that was there. */
export const commitHow = (spec: Pick<RunSpec, "kind" | "instruction" | "regenerate">): CommitHow =>
  spec.kind !== "refine" ? "draft" : spec.regenerate ? "regenerate" : spec.instruction === SHORTER ? "shorter" : spec.instruction === WARMER ? "warmer" : "rewrite";

export interface AiStrip {
  used: Extract<AiComposeResult, { status: "done" }>["used"];
  checks: Extract<AiComposeResult, { status: "done" }>["checks"];
  cutOff: boolean;
  oneTap: boolean;
  /** what the strip's Regenerate asks again */
  instruction: string;
  notes?: string;
  stack: AiCommit[];
  /** plan 144 revision 6: this came from a prepared reply */
  prepared?: PreparedRef;
  /** plan 161: typed in since its last write: the strip stays, as "Edited after AI" */
  edited?: boolean;
  /** plan 161, pass 3: its last write is what came before Esc or Stop: "Stopped part-way", and its use isn't known */
  stopped?: boolean;
}

export interface AiChoice {
  reason: "notes" | "typed";
  /** recipients moved while it was writing: "Written for Tom" */
  writtenFor: string | null;
  result: Extract<AiComposeResult, { status: "done" }>;
}

export interface AiError {
  message: string;
  /** the message's catalog key, if it came with one (plan 161, pass 2: a few are said as they are) */
  key?: string;
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
  /** the §5 call in flight, to stop with the row */
  intentRequest: string | null;
  /** "Include everyone (3)", on a reply narrowed to one person */
  everyone: number;
  run: Run | null;
  lastSpec: RunSpec | null;
  choice: AiChoice | null;
  held: { how: "replace" | "below"; result: Extract<AiComposeResult, { status: "done" }>; spec: RunSpec; prior: AiStrip | undefined; needsSubject: boolean } | null;
  error: AiError | null;
  strip: AiStrip | null;
  /** a send was stopped here: the row offers the choice; `sendAt` is what it was asked to do; `gaps`: the model's gaps still in the text (plan 161) */
  guard: { sendAt: number | undefined; gaps?: string[] } | null;
  /** what a screen reader hears: never the deltas */
  live: string;
  /** plan 161, pass 2: a run that would replace text typed since the AI wrote it, waiting for "Replace your edits?" */
  confirm: Replacement | null;
  /** plan 161, pass 2: the row's field holds the strip's own instruction, to write the draft again from new words */
  rewrite: boolean;
}

/** What replaces an edited draft, built when it's answered, from the text as it is then. */
export type Replacement = { how: "regenerate" | "shorter" | "warmer" } | { how: "refine" | "rewrite"; instruction: string } | { how: "retry"; spec: RunSpec };

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
export function previewMode(s: AiSession | undefined): "overlay" | "rewriting" | "below" | null {
  if (!s?.run) return null;
  const showing = s.phase === "writing" || s.phase === "waitingBody" || s.phase === "choice" || (s.phase === "error" && s.error?.partial === true);
  if (!showing) return null;
  if (s.run.typed || s.run.spec.kind === "notes" || s.phase === "choice") return "below";
  // plan 161, pass 2: a rewrite leaves the text it rewrites in place, dimmed, until the new one replaces it whole; what
  // came before a failure is offered under it
  if (s.run.spec.kind === "refine") return s.phase === "error" ? "below" : "rewriting";
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
  focusAnswered.delete(key);
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
  return { key, phase: o.phase, instruction: "", focus: 1, opened: o.opened, who: false, question: null, fromAccountId: null, confirmFailed: false, lookingUp: false, intentRequest: null, everyone: 0, run: null, lastSpec: null, choice: null, held: null, error: null, strip: null, guard: null, live: "", confirm: null, rewrite: false };
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
    const ready = draftingOffered(getApp());
    useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: newSession(key, { opened, phase: ready ? "input" : "noProvider" }) } }));
    publishBadges();
    return;
  }
  // ⌘J again in the field: it closes, as it opened
  if (s.phase === "input" && !s.strip && !s.instruction && rowFieldFocused(key)) return closeRow(key);
  if (s.phase === "strip") return update(key, { phase: "input", instruction: "", focus: s.focus + 1, who: false, rewrite: false, confirm: null });
  update(key, { focus: s.focus + 1 });
}

/** ⌘J, the buttons and the palette: the row on the draft named, or the one in front of the user, or the draft §5.2 opens. */
/** ⌘J, the Sparkles buttons and the palette: the row, on `key` if named, else on what's in front of the user (§5.3). */
export function openAiDraft(o: { key?: string; threadId?: number } = {}): void {
  if (!canDraft()) return;
  const app = getApp();
  if (app.dialog !== null || app.menuOpen) return;
  void openRow(o);
}

export async function openRow(o: { key?: string; threadId?: number; /** plan 162: the row opens holding this, only once it has really landed */ instruction?: string } = {}): Promise<void> {
  listen();
  const app = getApp();
  const seed = (key: string) => { if (o.instruction) setInstruction(key, o.instruction); };
  const key = o.key ?? draftKeyOf(document.activeElement) ?? app.compose?.key;
  if (key) {
    showRow(key, false);
    return seed(key);
  }
  const threadId = o.threadId ?? threadInFront();
  const onLanded = (landing: { kind: string; key: string }) => {
    showRow(landing.key, landing.kind === "created");
    seed(landing.key);
  };
  if (threadId !== null) {
    if (listLayout() && currentPage() === "list") openThread(threadId);
    const drafts = useDrafts.getState().drafts;
    const existing = shownDraftKey(drafts, threadId, getApp().draftShown);
    // an open still on its way is what they asked for: it goes on as that, with this row
    await composeLanding(existing ? drafts[existing]!.mode : composeOpening(threadId) ?? "reply", threadId, 0, undefined, undefined, { target: "ai", onLanded });
    return;
  }
  await composeLanding("new", null, 0, undefined, undefined, { target: "ai", onLanded });
}

/** The draft answering this thread, as it stands, for what opens one and goes on (plan 142's Nudge). */
export function rowKeyOf(threadId: number): string | null {
  return shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) ?? null;
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
  // (another draft's editor is somewhere else they moved on to)
  if (active && active !== document.body && !rowOwns(active, key) && !(active.getAttribute("data-testid") === "compose-body" && draftKeyOf(active) === key)) return;
  focusBody(key, "keep");
}
const rowOwns = (el: Element, key: string) => el.closest(`[data-ai-row="${CSS.escape(key)}"]`) !== null;

/**
 * The row goes; the strip comes back if it was opened over one; the caret goes back to the text. ⌘J again takes an empty
 * draft it opened with it, as it opened both; Esc (`keepDraft`, plan 161 pass 2) closes only the row, and the empty reply
 * stays open for the composer's own Esc.
 */
export function closeRow(key: string, o: { keepDraft?: boolean } = {}) {
  const s = session(key);
  if (!s) return;
  cancel(s);
  const d = draftOf(key);
  if (s.strip) {
    update(key, { phase: "strip", instruction: "", question: null, error: null, who: false, confirmFailed: false, lookingUp: false, intentRequest: null, rewrite: false, confirm: null });
    return focusEditor(key);
  }
  const untouched = !o.keepDraft && s.opened && d !== undefined && !authored(d);
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
  if (!draftingOffered(getApp())) return update(key, { phase: "noProvider" });
  if (instruction) memory.last = instruction;
  update(key, { error: null, confirmFailed: false, question: null, who: false });
  // the strip's own instruction, edited: the draft written again from the new words (plan 161, pass 2)
  if (s.strip && s.rewrite) return replacing(key, { how: "rewrite", instruction });
  // ⌘J over the strip: free-form refining, instant to assemble and cheap
  if (s.strip) return instruction ? replacing(key, { how: "refine", instruction }) : refine(key, "regenerate");
  if (!instruction) {
    if (d.mode === "new" && !validRecipients(d.toText).length) return askWho(key);
    return startRun(key, runFor(key, ""));
  }
  await resolve(key, instruction, d);
}

function runFor(key: string, instruction: string): RunSpec {
  const notes = bodyNow(key);
  if (notes.trim()) return { kind: "notes", instruction, notes };
  // an image alone has no words for the model, but it's the user's: nothing goes over it without a choice
  const c = controllerFor(key);
  return c && !c.empty() ? { kind: "notes", instruction, notes: "" } : { kind: "draft", instruction };
}

function askWho(key: string) {
  const s = session(key);
  if (!s) return;
  update(key, { phase: "input", who: true, live: t("aiDraft.who"), lookingUp: false });
  focusSoon(`[data-draft-key="${CSS.escape(key)}"] [data-testid=compose-to]`, null, 12);
}

async function resolve(key: string, instruction: string, d: LocalDraft) {
  const surface = surfaceOf(d);
  const requestId = globalThis.crypto.randomUUID();
  const asked = () => { const now = session(key); return now?.phase === "resolving" && now.intentRequest === requestId; };
  update(key, { phase: "resolving", lookingUp: false, intentRequest: requestId });
  const accountId = surface.kind === "list" ? getApp().accountId ?? undefined : d.accountId;
  // who it's on now: a decision is about these, and someone typing a name meanwhile has answered part of it
  const on = `${d.accountId}|${addresses(d.toText)}|${addresses(d.ccText)}`;
  let result: AiIntentResult;
  try {
    result = await client.call("ai.resolveIntent", { requestId, instruction, surface, ...(accountId !== undefined ? { accountId } : {}) });
    if (!asked()) return;
    if (result.decision.kind === "wait") {
      // "not ready" is never "no such person": it answers when the index is warm, with nothing to poll
      const again = globalThis.crypto.randomUUID();
      update(key, { lookingUp: true, intentRequest: again });
      result = await client.call("ai.resolveIntent", { requestId: again, instruction, surface, waitForContacts: true, ...(accountId !== undefined ? { accountId } : {}) });
      if (session(key)?.intentRequest !== again) return;
    }
  } catch (error) {
    const now = session(key);
    if (now?.phase === "resolving" && now.intentRequest) failed(key, error);
    return;
  }
  const current = materialize(key);
  if (!current) return;
  update(key, { intentRequest: null, lookingUp: false, confirmFailed: result.confirmFailed, fromAccountId: result.fromAccountId });
  if (`${current.accountId}|${addresses(current.toText)}|${addresses(current.ccText)}` !== on) return resolve(key, instruction, current);
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
      if (session(key)?.phase !== "resolving") return;
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
  // newer work: an edited Undo's way back is over, even if this run ends with nothing written
  restores.delete(key);
  // plan 147: every way to run comes here (Shorter, Try again, an answered question). The strip stays, with its Undo
  if (!draftingOffered(getApp())) return update(key, { phase: "noProvider" });
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
    confirm: null,
    rewrite: false,
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
    ...(spec.notes?.trim() ? { draft: spec.notes } : {}),
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
  // what a screen reader hears is what's shown: never the provider's address (plan 161, pass 2)
  const said = aiErrorCopy({ message, kind, key: e.i18n?.key }, errorTarget(writingTarget(ai).provider, ai)).title;
  update(key, { phase: "error", error: { message, help, kind: kind ?? "other", retry: e.code !== "NOT_FOUND" && kind !== "unsupported", partial, ...(e.i18n?.key ? { key: e.i18n.key } : {}) }, live: said, strip: partial ? s.strip : prior, run: partial ? s.run : null });
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

/**
 * The strip a refinement began from still describes the text: it's the version it wrote, or (plan 161, Codex review) an
 * edited strip whose text nothing has touched since the refinement began.
 */
function priorStands(prior: AiStrip, run: Run | null | undefined, c: ReturnType<typeof controllerFor>): boolean {
  if (!c) return true;
  const token = c.docToken();
  return token === prior.stack[prior.stack.length - 1]?.doc || (prior.edited === true && token === run?.binding.doc);
}

/**
 * Esc and the row's Stop: it ends, and the strip comes back if there was one. Plan 161, pass 3: nothing the user had is lost
 * (Esc used to take the instruction and the words that had come): what came goes into the draft as a write of its own,
 * "Stopped part-way", which Undo takes back; with nothing yet, the row's field holds the instruction again, for Return.
 */
export function stop(key: string) {
  const s = session(key);
  if (!s) return;
  cancel(s);
  stopWaiting(key);
  const prior = s.run?.prior;
  const c = controllerFor(key);
  if (prior && priorStands(prior, s.run, c)) {
    clearStream(key);
    update(key, { phase: "strip", strip: prior, run: null, choice: null, error: null, guard: null, live: "" });
    return focusEditor(key);
  }
  const spec = s.run?.spec;
  const text = previewText(key).trim();
  // a rewrite keeps the text it rewrites where it is, and its own words aren't a draft: only a first write's are kept
  if (spec && spec.kind !== "refine" && text && c && s.phase === "writing") {
    // below the user's notes (or an image) as Insert puts what came before a failure; over an empty body, the draft
    const result: Extract<AiComposeResult, { status: "done" }> = { status: "done", text, subject: null, stop: "end", used: emptyUsed(), checks: { specifics: [], placeholders: [] } };
    if (commit(key, c.empty() ? "replace" : "below", result, spec, undefined, false, { stopped: true })) return focusEditor(key);
  }
  clearStream(key);
  if (spec && spec.kind !== "refine") {
    update(key, { phase: "input", instruction: spec.instruction, run: null, choice: null, error: null, guard: null, strip: null, rewrite: false, live: spec.instruction ? t("aiDraft.live.stoppedEmpty") : "", focus: s.focus + 1 });
    return;
  }
  remove(key);
  focusEditor(key);
}

function cancel(s: AiSession) {
  const requestId = s.run?.requestId;
  if (requestId && requests.delete(requestId)) void quietly(() => client.call("ai.cancel", { requestId }));
  const intent = s.intentRequest;
  if (intent) void quietly(() => client.call("ai.cancel", { requestId: intent }));
  clearSlow(s.key);
}

// ── commit

function commit(key: string, how: "replace" | "below", result: Extract<AiComposeResult, { status: "done" }>, spec: RunSpec, prior: AiStrip | undefined, needsSubject: boolean, o: { stopped?: boolean } = {}): boolean {
  const c = controllerFor(key);
  if (!c) {
    // pinning, collapsing or another thread took the editor: it goes in when one is there
    update(key, { phase: "held", held: { how, result, spec, prior, needsSubject }, run: null, live: "" });
    return true;
  }
  const before = c.snapshot();
  const inserted = c.insertGenerated(result.text, how, result.checks.placeholders[0], result.checks.placeholders);
  if (!inserted) {
    snack.error(t("aiDraft.cantInsert"));
    return false;
  }
  const d = draftOf(key);
  // never over a subject the user wrote (§10.3)
  let subject: string | null = null;
  if (needsSubject && result.subject && d && !d.subject.trim() && editDraft(key, { subject: result.subject, subjectEdited: true })) subject = result.subject;
  // a refinement (Shorter, Warmer, "make it formal") rewrites the text, not what was asked: the strip keeps the words a
  // Regenerate asks again and the row shows (plan 161, pass 2)
  const refined = spec.kind === "refine" && !spec.regenerate && prior !== undefined;
  const instruction = refined ? prior.instruction : spec.instruction;
  const notes = refined ? prior.notes : spec.notes;
  const stack = [...(prior?.stack ?? []), { doc: inserted.doc, subject, before, beforeDoc: inserted.before, checks: result.checks, text: c.snapshot().text, instruction, how: prior ? commitHow(spec) : "draft", ...(notes !== undefined ? { notes } : {}), ...(o.stopped ? { stopped: true } : {}) }];
  restores.delete(key);
  // what the draft holds now, as a send will compare it: a replace is all of the text, an insert only what it wrote
  recordProvenance(key, how === "replace" ? c.snapshot().text : result.text);
  clearStream(key);
  const strip: AiStrip = { used: result.used, checks: result.checks, cutOff: result.stop === "length", oneTap: refined ? prior.oneTap : !spec.instruction && spec.kind === "draft", instruction, ...(spec.prepared ?? prior?.prepared ? { prepared: (spec.prepared ?? prior?.prepared)! } : {}), ...(notes !== undefined ? { notes } : {}), ...(o.stopped ? { stopped: true } : {}), stack };
  update(key, { phase: "strip", strip, run: null, choice: null, held: null, error: null, guard: null, instruction: "", live: o.stopped ? t("aiDraft.live.stopped") : t("aiDraft.live.ready", { count: wordCount(result.text) }) });
  return true;
}

/** What going back to a version brings with it: its checks, and what it was asked (plan 161, pass 2). */
function versionOf(v: AiCommit): Pick<AiStrip, "checks" | "stopped"> & Partial<Pick<AiStrip, "instruction" | "notes">> {
  return { checks: v.checks, stopped: v.stopped === true, ...(v.instruction !== undefined ? { instruction: v.instruction } : {}), ...(v.notes !== undefined ? { notes: v.notes } : {}) };
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
  const ai = aiSettings();
  const target = writingTarget(ai);
  // the model drafts run on, as the backend picks it (Codex review of pass 3: Settings' first row's was named)
  const model = ai ? writingModel(ai) : "";
  return { levels: [], personFromOtherAccount: false, examples: 0, pastConversations: 0, mentions: 0, threadMessages: 0, history: "none", learning: false, inboundSnippetOnly: false, language: "", languageReason: "unknown", provider: target.provider, model, reused: false };
}

/** Discard: the document never had it. */
export function discard(key: string) {
  const s = session(key);
  if (!s) return;
  clearStream(key);
  if (s.phase === "choice" && preparedDrafts.has(key)) {
    const held = preparedDrafts.get(key)!;
    preparedDrafts.delete(key);
    preparedHooks.back?.(held.ref);
  }
  const prior = s.run?.prior;
  const c = controllerFor(key);
  if (prior && priorStands(prior, s.run, c)) {
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

/** What's committed and not yet known to the backend; a send asks again, since with no row the mail would count as the user's. */
const provenance = new Map<string, { text: string; run: Promise<boolean> }>();

async function writeProvenance(key: string, text: string): Promise<boolean> {
  // after the first save has given the draft its id
  await flushDraft(key, true);
  const d = draftOf(key);
  if (!d || d.id === null || !d.generation) return false;
  try {
    await client.call("writing.commitGeneration", { accountId: d.accountId, draftId: d.id, draftGeneration: d.generation, address: parseAddressList(d.toText)[0]?.email ?? "", text });
    return true;
  } catch {
    return false;
  }
}

function recordProvenance(key: string, text: string) {
  const entry = { text, run: writeProvenance(key, text) };
  provenance.set(key, entry);
  void entry.run.then((ok) => { if (ok && provenance.get(key) === entry) provenance.delete(key); });
}

// ── the strip

export const SHORTER = "Shorter. Keep every fact and commitment.";
export const WARMER = "Warmer, the way this person would be. Keep every fact and commitment.";

export function refine(key: string, how: "regenerate" | "shorter" | "warmer") {
  replacing(key, { how });
}

/** What a replacement asks, from the strip and the text as they are now. */
function specOf(strip: AiStrip, r: Replacement, key: string): RunSpec {
  switch (r.how) {
    case "regenerate":
    case "rewrite": {
      const instruction = r.how === "rewrite" ? r.instruction : strip.instruction;
      return strip.notes !== undefined ? { kind: "refine", instruction, notes: strip.notes, regenerate: true } : { kind: "refine", instruction, regenerate: true };
    }
    case "shorter":
    case "warmer":
      return { kind: "refine", instruction: r.how === "shorter" ? SHORTER : WARMER, previous: bodyNow(key) };
    case "refine":
      return { kind: "refine", instruction: r.instruction, previous: bodyNow(key) };
    // Try again: what was asked, from the text as it is now when it rewrites it
    case "retry":
      return r.spec.previous !== undefined ? { ...r.spec, previous: bodyNow(key) } : r.spec;
  }
}

/**
 * Plan 161, pass 2: anything that replaces the strip's text. Over text typed since the AI wrote it ("Edited after AI"),
 * the strip asks first, inline: "Replace your edits?". Untouched, it runs at once.
 */
function replacing(key: string, r: Replacement): void {
  const s = session(key);
  if (!s?.strip) return;
  if (s.strip.edited) {
    update(key, { phase: "strip", confirm: r, instruction: "", rewrite: false, live: t("aiDraft.confirm.title"), focus: s.focus + 1 });
    return;
  }
  startRun(key, specOf(s.strip, r, key));
}

/** "Replace": the run that was asked, from the text as it is now. Undo still brings the edits back exactly. */
export function confirmReplace(key: string): void {
  const s = session(key);
  if (!s?.strip || !s.confirm) return;
  startRun(key, specOf(s.strip, s.confirm, key));
}

/** "Keep editing", and Esc: nothing runs, and the caret is back in the text. */
export function keepEdits(key: string): void {
  const s = session(key);
  if (!s?.confirm) return;
  update(key, { confirm: null, live: "" });
  focusEditor(key);
}

/** The strip's instruction, to write the draft again from new words: the row's field, holding it. */
export function editInstruction(key: string): void {
  const s = session(key);
  if (!s?.strip) return;
  update(key, { phase: "input", instruction: s.strip.instruction, rewrite: true, confirm: null, who: false, focus: s.focus + 1 });
}

const undoing: { key: string | null } = { key: null };

/**
 * The strip's Undo: the text as ordinary undo would take it back, and a subject this filled, if nobody has edited it
 * since (§10.3). Under a refinement it goes back one version, and the strip stays for the one before.
 */
export function undoCommit(key: string) {
  const s = session(key);
  const top = s?.strip?.stack[s.strip.stack.length - 1];
  if (!s?.strip || !top) return;
  const c = controllerFor(key);
  // typed in since, or undone by ⌘Z past it: the editor's undo would take back the wrong step, so the document goes back exactly
  if (c && (s.strip.edited || c.docToken() !== top.doc)) return undoEdited(key, s as AiSession & { strip: AiStrip }, top);
  undoing.key = key;
  const undone = c?.undoGenerated(top.doc);
  undoing.key = null;
  if (!undone) {
    // an editor rebuilt without its history (its cache is bounded): the same words, put back by hand, if they're still what it wrote
    if (bodyNow(key) !== top.text) {
      remove(key);
      return focusEditor(key);
    }
    editDraft(key, { bodyHtml: top.before.html, bodyText: top.before.text });
  }
  const d = draftOf(key);
  if (top.subject !== null && d?.subject === top.subject) editDraft(key, { subject: "", subjectEdited: false });
  const stack = s.strip.stack.slice(0, -1);
  const under = stack[stack.length - 1];
  if (under && undone) {
    stack[stack.length - 1] = { ...under, doc: undone.doc };
    update(key, { strip: { ...s.strip, stack, ...versionOf(under) } });
    recordProvenance(key, bodyNow(key));
    return focusEditor(key);
  }
  // plan 161, pass 3: a stopped write taken back gives the field its instruction again (it's the user's too), for Return.
  // Plan 162 (after ai162-r02): so does the first draft taken back: the row stays with what was asked, ready to change or
  // ask again (it went, row and words, and the words had to be typed again)
  if (!preparedDrafts.has(key)) {
    update(key, { phase: "input", instruction: s.strip.instruction, strip: null, rewrite: false, live: "", focus: s.focus + 1 });
    // a reply this ⌘J opened, with nothing left in it: no blank draft stays in the list (the composer and the row stay)
    const left = draftOf(key);
    if (s.opened && left && !bodyNow(key).trim() && !left.attachments?.length) void Promise.resolve(provenance.get(key)?.run).finally(() => unsaveDraft(key));
    return;
  }
  remove(key);
  if (preparedDrafts.has(key)) return backToNothing(key);
  focusEditor(key);
  // this draft was only ever what's just gone: no blank one stays in the list
  const left = draftOf(key);
  if (s.opened && left && !bodyNow(key).trim() && !left.attachments?.length) void forgetUndone(key);
}

/**
 * Plan 161: Undo on a strip typed in since. The document goes back exactly to what the AI's last write found (before ⌘J,
 * or before the Shorter, Warmer or Regenerate that made this version), as one editor step; what was typed since goes with
 * it, and the snack's Undo (or ⌘Z) brings that back exactly, the strip with it.
 */
function undoEdited(key: string, s: AiSession & { strip: AiStrip }, top: AiCommit) {
  const c = controllerFor(key);
  // anything typed, formatting and images included: the document, not its text
  const typed = c ? !c.sameDoc(top.doc) : false;
  const edited = c?.docToken();
  undoing.key = key;
  const restored = c?.restoreGenerated(top.beforeDoc) ?? null;
  undoing.key = null;
  if (!c || !restored) return;
  const was = s.strip;
  const d = draftOf(key);
  const subject = top.subject !== null && d?.subject === top.subject ? top.subject : null;
  if (subject !== null) editDraft(key, { subject: "", subjectEdited: false });
  const stack = was.stack.slice(0, -1);
  const under = stack[stack.length - 1];
  let left: AiStrip | null = null;
  if (under) {
    // the version under it is back as it was written, or as it was typed over before this write. Its Undo restores too
    // from here: the editor's last step is now this restore, not its write
    left = { ...was, stack, ...versionOf(under), edited: !c.sameDoc(under.doc) };
    update(key, { strip: left });
    recordProvenance(key, bodyNow(key));
  } else if (was.stopped && !preparedDrafts.has(key)) {
    // plan 161, pass 3: a stopped write gives the field its instruction back, as its unedited Undo does
    update(key, { phase: "input", instruction: was.instruction, strip: null, rewrite: false, live: "" });
  } else {
    remove(key);
    // the draft stays, even blank: what was typed is one Undo away (the unedited Undo forgets a blank one)
    if (preparedDrafts.has(key)) backToNothing(key);
  }
  focusEditor(key);
  // nothing typed (an editor rebuilt without its history, or ⌘Z already past it): nothing to bring back
  if (!typed) return;
  const r: Restore = { edited, restored: restored.doc, strip: { ...was, edited: true }, left, subject, opened: s.opened, lastSpec: s.lastSpec, back: false };
  restores.set(key, r);
  const undo = registerUndo(() => {
    // newer work since (another write, a refinement running), or it's back already: this old Undo does nothing
    if (r.back || !stillOurs(key, r)) return;
    undoing.key = key;
    const back = controllerFor(key)?.undoGenerated(r.restored) ?? null;
    undoing.key = null;
    if (back) reinstate(key, r);
  });
  snack.success(t("aiDraft.undone"), { action: { label: t("common.undo"), name: t("aiDraft.undoneUndo"), undo } });
}

/** ⌘⇧Z after the edited text came back: the draft as the edited Undo left it, its strip (or none) and its subject. */
function retake(key: string, r: Restore): void {
  r.back = false;
  if (r.subject !== null && draftOf(key)?.subject === r.subject) editDraft(key, { subject: "", subjectEdited: false });
  if (r.left) update(key, { phase: "strip", strip: r.left });
  // plan 161, pass 3: a stopped write's Undo, again: the field with its instruction, as the first time
  else if (r.strip.stopped) update(key, { phase: "input", instruction: r.strip.instruction, strip: null, rewrite: false });
  else remove(key);
  recordProvenance(key, bodyNow(key));
}

/**
 * Plan 161 (Codex review): what an edited Undo took away, so the snack's Undo and the editor's own ⌘Z bring back the
 * same thing: the edited text (the editor's), and with it the strip, its subject and its gaps' guard (ours). Only while
 * nothing newer has happened to the session: `left` is the strip the Undo left behind (null: none).
 */
interface Restore {
  edited: unknown;
  restored: unknown;
  strip: AiStrip;
  left: AiStrip | null;
  subject: string | null;
  opened: boolean;
  lastSpec: RunSpec | null;
  /** brought back (by ⌘Z or the snack): ⌘⇧Z takes it away again, and ⌘Z brings it back again */
  back: boolean;
}
const restores = new Map<string, Restore>();

function stillOurs(key: string, r: Restore): boolean {
  const s = session(key);
  if (restores.get(key) !== r) return false;
  const shown = r.back ? r.strip : r.left;
  // plan 161, pass 3: a stopped write's Undo leaves the field with its instruction, not nothing (Codex review)
  // and only while the field holds what the Undo left there: a new instruction is newer work (second review)
  if (s && shown === null) return s.phase === "input" && !s.run && s.strip === null && s.instruction === r.strip.instruction;
  return s ? s.phase === "strip" && !s.run && s.strip === shown : shown === null;
}

function reinstate(key: string, r: Restore): void {
  r.back = true;
  if (r.subject !== null && draftOf(key)?.subject === "") editDraft(key, { subject: r.subject, subjectEdited: true });
  if (!session(key)) useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: { ...newSession(key, { opened: r.opened, phase: "strip" }), lastSpec: r.lastSpec } } }));
  update(key, { phase: "strip", strip: r.strip, instruction: "", rewrite: false });
  recordProvenance(key, bodyNow(key));
  focusEditor(key);
}

/** Drafts that hold a prepared reply: what to give back, whether it's been typed in, whether this draft began with it. */
const preparedDrafts = new Map<string, { ref: PreparedRef; text: string; typed: boolean; opened: boolean; seen: boolean }>();
// the strip, and whatever else listens to the editor, ends at the first keystroke: this lasts as long as the draft does
useDrafts.subscribe((state) => {
  for (const [key, held] of preparedDrafts) {
    // sent, discarded, its account gone: nothing keeps the words
    if (!state.drafts[key]) {
      preparedDrafts.delete(key);
      continue;
    }
    const body = bodyNow(key);
    if (body.trim()) {
      held.seen = true;
      held.typed ||= body !== held.text;
    } else if (held.seen && !state.drafts[key]!.sending) backToNothing(key);
  }
});
export const preparedHooks: { back: ((prepared: PreparedRef) => void) | null } = { back: null };
// plan 161, pass 2: a draft made from a prepared reply, discarded (its Discard, or closed empty): the reply is offered again,
// as Undo after Use offers it. Sent, nothing comes back
discardListeners.add((key) => {
  const held = preparedDrafts.get(key);
  if (!held) return;
  preparedDrafts.delete(key);
  preparedHooks.back?.(held.ref);
});

function backToNothing(key: string): void {
  const held = preparedDrafts.get(key);
  if (!held) return;
  preparedDrafts.delete(key);
  const back = () => preparedHooks.back?.(held.ref);
  // only ever these words: the draft goes, and the block is back in its place. Typed in: the draft is theirs, and the reply waits behind it.
  if (held.opened && !held.typed && !bodyNow(key).trim() && !draftOf(key)?.attachments?.length) void discardDraft(key).then(back, back);
  else back();
}

/**
 * Plan 144: Use. The words go in as a one-tap draft would, one undo step, with no request. On a draft with work in it
 * they're only offered: the same choice as text arriving under someone's typing (revision 2).
 */
export function commitPrepared(key: string, row: PreparedReply, opened: boolean): boolean {
  const d = draftOf(key);
  // to someone else now: the words were for who they were for, so they're only offered (revision 2)
  const inDraft = new Set(d ? parseAddressList(d.toText).map((a) => a.email.toLowerCase()) : []);
  const forOthers = row.to.some((a) => !inDraft.has(a.email.toLowerCase()));
  const c = controllerFor(key);
  const result: Extract<AiComposeResult, { status: "done" }> = { status: "done", text: row.body ?? "", subject: null, stop: "end", used: row.used ?? emptyUsed(), checks: row.checks ?? { specifics: [], placeholders: [] } };
  const spec: RunSpec = { kind: "draft", instruction: "", prepared: { threadId: row.threadId, rowId: row.rowId, revision: row.revision } };
  if (!session(key)) useAiDraft.setState(({ sessions }) => ({ sessions: { ...sessions, [key]: newSession(key, { opened, phase: "strip" }) } }));
  update(key, { lastSpec: spec });
  if (!(c ? c.empty() : bodyNow(key) === "") || forOthers) {
    preparedDrafts.set(key, { ref: spec.prepared!, text: result.text, typed: true, opened: false, seen: true });
    update(key, { phase: "choice", choice: { reason: "typed", writtenFor: forOthers ? (row.to[0]?.name || row.to[0]?.email || null) : null, result }, live: t("aiDraft.live.ready", { count: wordCount(result.text) }) });
    focusEditor(key);
    return false;
  }
  const done = commit(key, "replace", result, spec, undefined, false);
  if (done) preparedDrafts.set(key, { ref: spec.prepared!, text: result.text, typed: false, opened, seen: false });
  focusEditor(key);
  return done;
}

/** After the save that recorded it, which would otherwise bring the row back; not if something else began meanwhile. */
async function forgetUndone(key: string) {
  await provenance.get(key)?.run;
  provenance.delete(key);
  if (session(key) || bodyNow(key).trim()) return;
  // plan 162: the reply ⌘J opened goes with what it wrote, and the keys go back to the reply bar it came from, never to
  // the page (its Undo was the last focused thing, and it's gone)
  const thread = draftOf(key)?.threadId ?? null;
  const hadFocus = document.activeElement === document.body || draftKeyOf(document.activeElement) === key || (document.activeElement?.closest(`[data-ai-row="${CSS.escape(key)}"]`) ?? null) !== null;
  await unsaveDraft(key);
  if (hadFocus && thread !== null) focusSoon(`[data-testid=draft-slot][data-thread="${thread}"] [data-testid=quick-reply]`, null, 12, () => document.activeElement === document.body || document.activeElement === null, () => true);
}

/** Any change of the text: typing during a stream makes the result a suggestion; the strip lasts until the next keystroke. */
export function noteBody(key: string) {
  // the strip's own Undo changes the text too: it isn't a keystroke
  if (undoing.key === key) return;
  const c0 = controllerFor(key);
  const held = preparedDrafts.get(key);
  // revision 6: through edits, refinements and remounts: back to nothing, the reply is there again
  if (held && c0) {
    if (c0.empty() && held.seen) {
      if (session(key)) remove(key);
      return backToNothing(key);
    }
    if (!c0.empty()) {
      held.seen = true;
      held.typed ||= bodyNow(key) !== held.text;
    }
  }
  const s = session(key);
  const c = c0;
  // ⌘Z right after an edited Undo: the edited text is back, and so is everything that went with it
  const r = restores.get(key);
  if (r && c && stillOurs(key, r)) {
    if (!r.back && c.sameDoc(r.edited)) return reinstate(key, r);
    // ⌘⇧Z: the Undo again, as it was
    if (r.back && c.sameDoc(r.restored)) return retake(key, r);
  }
  if (!s || !c) return;
  if (s.run && (s.phase === "writing" || s.phase === "waitingBody" || s.phase === "error")) {
    const typed = s.run.spec.kind === "draft" ? !c.empty() : c.docToken() !== s.run.binding.doc;
    if (typed !== s.run.typed) update(key, { run: { ...s.run, typed } });
    return;
  }
  const top = s.strip?.stack[s.strip.stack.length - 1];
  if (!s.strip || !top || c.docToken() === top.doc) return;
  // ⌘Z took the write back whole: the strip goes with it (the version under it stays), as the strip's own Undo does
  if (c.sameDoc(top.beforeDoc)) {
    const stack = s.strip.stack.slice(0, -1);
    const under = stack[stack.length - 1];
    if (!under) {
      if (s.phase === "strip") remove(key);
      else update(key, { strip: null });
      return;
    }
    return update(key, { strip: { ...s.strip, stack, ...versionOf(under), edited: !c.sameDoc(under.doc) } });
  }
  // plan 161: an edit no longer ends the strip; it says so, and Undo stays until the draft is sent
  if (!s.strip.edited) update(key, { strip: { ...s.strip, edited: true } });
}

// ── send guard, Esc

const UNDECIDED: readonly AiPhase[] = ["writing", "waitingBody", "choice", "held"];
const undecided = (s: AiSession) => UNDECIDED.includes(s.phase) || (s.phase === "error" && s.error?.partial === true);

aiDraftHooks.blocksSend = (key, sendAt) => {
  const s = session(key);
  if (!s) return false;
  if (undecided(s)) {
    update(key, { guard: { sendAt }, live: t("aiDraft.guard.live"), focus: s.focus + 1 });
    return true;
  }
  // plan 161: a gap the model left, still in the text: asked once, inline, before it goes
  const gaps = gapsLeft(key, s);
  if (!gaps.length) return false;
  update(key, { guard: { sendAt, gaps }, live: t("aiDraft.gaps.live"), focus: s.focus + 1 });
  return true;
};

/** The model's gaps (only those, never a bracket the user typed) still in the draft's text. */
export function gapsLeft(key: string, s: AiSession | undefined = session(key)): string[] {
  // every version's: an undo in the editor can bring back an earlier one's
  const gaps = [...(s?.strip?.checks.placeholders ?? []), ...(s?.strip?.stack.flatMap((v) => v.checks.placeholders) ?? [])];
  if (!gaps.length) return [];
  const body = bodyNow(key);
  return [...new Set(gaps)].filter((g) => body.includes(g));
}

aiDraftHooks.provenance = async (key) => {
  const entry = provenance.get(key);
  if (!entry) return;
  // the first try failed (its save, or the call): the draft has its id by now, so once more before the send
  if (!(await entry.run)) await writeProvenance(key, entry.text);
  if (provenance.get(key) === entry) provenance.delete(key);
};

/** The row's control takes focus for a request once: a row that mounts again (back in the conversation) doesn't take it again. */
const focusAnswered = new Map<string, number>();
export function takeFocusRequest(key: string, seq: number): boolean {
  if (!seq || focusAnswered.get(key) === seq) return false;
  focusAnswered.set(key, seq);
  return true;
}

aiDraftHooks.working = (key) => session(key) !== undefined;
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
  if (s.confirm) {
    keepEdits(key);
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
    case "error":
    case "noProvider":
      if (s.error?.partial) discard(key);
      // plan 161, pass 2: only the row: an empty reply ⌘J opened stays, for the composer's own Esc
      else closeRow(key, { keepDraft: true });
      return true;
  }
};

/** The guard's other answer: nothing changes, and the text is where they were; for gaps, the first one is selected to type over. */
export function keepWriting(key: string) {
  const gap = session(key)?.guard?.gaps?.[0];
  update(key, { guard: null, live: "" });
  if (gap) controllerFor(key)?.selectText(gap);
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
  // a rewrite that failed, over text typed in since: Try again asks first, as the rewrite did (Codex review). A failure
  // part-way keeps its strip in the run (what came is offered with Insert); Try again sets that aside and asks the same
  if (s?.lastSpec?.kind === "refine") {
    const strip = s.strip ?? s.run?.prior ?? null;
    const top = strip?.stack[strip.stack.length - 1];
    const c = controllerFor(key);
    if (strip && (strip.edited === true || (c && top ? !c.sameDoc(top.doc) : false))) {
      clearStream(key);
      update(key, { strip: { ...strip, edited: true }, run: null, error: null });
      return replacing(key, { how: "retry", spec: s.lastSpec });
    }
  }
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
      if (getApp().selectedId !== threadId || !now?.presentationExpired || !session(key)) return;
      if (context?.threadId === threadId) validateDraftPresentation(key, threadId);
      // it isn't here any more: the strip has it (plan 158)
      else loseDraftHome(key);
    })();
  }
});

// ── what happens to the draft under it

useDrafts.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  // an edited Undo's way back goes with its draft
  for (const key of restores.keys()) if (!state.drafts[key]) restores.delete(key);
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
