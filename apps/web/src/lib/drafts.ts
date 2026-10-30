import { formatAddressList, isValidEmail, parseAddressList, type Address } from "@terno/core";
import { t } from "@terno/i18n";
import type { Draft, DraftAddress, DraftMode, ReplyContext } from "@terno/core/rpc";
import { create } from "zustand";
import { emailDocument, GAP, signatureHtml, textToHtml } from "@terno/richtext/quote";
import { client } from "~/rpc/connection";
import { exposeForTests } from "~/lib/render-probe";

/**
 * Drafts in the renderer: one entry per draft, keyed by a stable client key
 * (the server id arrives with the first acknowledged save), and their write
 * lifecycle.
 *
 * - Every edit bumps a local revision and marks the draft dirty. A save goes
 *   out 800 ms after the last edit, and at least every 5 s while typing.
 * - At most one save is in flight per draft; its answer applies to the draft
 *   (key) it was sent for, never to "the current draft".
 * - "Draft saved" means the acknowledged revision is the local one.
 * - A failed save says so and retries (1, 2, 5 s); the text stays in memory.
 * - Send, discard and flush first cancel the debounce and wait for the save
 *   in flight. The server's revision travels with every save: an edit made on
 *   a revision another writer replaced becomes its own draft, never an
 *   overwrite. A null save makes its storage target terminal; local work
 *   remains until an explicit copy is acknowledged or deliberately discarded.
 *
 * What can be lost in a crash: edits since the last acknowledgement (≤ 800 ms
 * after a pause, ≤ 5 s while typing).
 *
 * Rich text (plan 16): the editor owns the body while it is mounted. Each
 * change marks the draft dirty (an edit with no fields) and its body source
 * dirty; the body is serialized (mail HTML and its plain-text alternative,
 * from the same document) only when it is needed: before a save, a flush, a
 * send, a discard or a snapshot of the fields. A body patch from anywhere
 * else bumps `bodyVersion`, and a mounted editor that didn't write it
 * reloads its document.
 */

export type DraftStatus = "clean" | "dirty" | "saving" | "saved" | "error";

/** Per field, the addresses Terno put there (anything else in that field the user typed). */
export interface AutoRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}
export const NO_AUTO: AutoRecipients = { to: [], cc: [], bcc: [] };

export interface DraftRecovery {
  state: "missing" | "copying" | "refused" | "unknown";
  reason?: "assets" | "account" | "context" | "size" | "invalid";
  uncertain?: true;
}

export interface LocalDraft {
  key: string;
  /** server id, once a save was acknowledged */
  id: number | null;
  /** the server revision this draft's content is based on */
  revision: number;
  generation?: string;
  /** Independent of save status: typing and UI changes cannot revive a terminal target. */
  recovery?: DraftRecovery;
  /** Session-only editor placement when storage context normalizes to standalone. */
  presentationThreadId?: number;
  /** Cached DTO association: an expired mount cannot display it without explicit point validation. */
  sourceContextThreadId?: number | null;
  departedThreadId?: number;
  presentationEpoch?: number;
  presentationExpired?: boolean;
  showSourceContext?: boolean;
  status: DraftStatus;
  /** bumped by every edit; saved = what the server acknowledged */
  localRev: number;
  savedRev: number;
  accountId: number;
  threadId: number | null;
  mode: DraftMode;
  /** recipients as typed (comma-separated); `auto` remembers, per field, which addresses Terno filled in there */
  toText: string;
  ccText: string;
  bccText: string;
  auto: AutoRecipients;
  subject: string;
  subjectEdited: boolean;
  /** the written part's plain text (always the alternative of bodyHtml when there is one) */
  bodyText: string;
  /** the written part as mail HTML ('' = a plain draft, opened as its text) */
  bodyHtml: string;
  quotedText: string;
  includeQuote: boolean;
  replyContext?: ReplyContext | null;
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
  uiState: "open" | "collapsed";
  updatedAt: number;
  /** a send is in flight: the draft can't be edited or discarded until it settles */
  sending: boolean;
  /** bumped when the body changes other than through its editor (not stored) */
  bodyVersion: number;
  /** bodyHtml came from this session's editor (a stored one is re-read through the schema before it is sent) */
  canonical: boolean;
  attachments?: import("@terno/core").AttachmentRef[];
  /** A stored or in-flight revision still owns files; only an empty save acknowledgement unlocks From. */
  attachmentOwner?: boolean;
  /** the last save was refused for good (too long): no automatic retries */
  tooLong: boolean;
}

export type DraftFields = Pick<
  LocalDraft,
  "showSourceContext" | "attachments" | "accountId" | "threadId" | "mode" | "toText" | "ccText" | "bccText" | "auto" | "subject" | "subjectEdited" | "bodyText" | "bodyHtml" | "quotedText" | "includeQuote" | "replyContext" | "inReplyToMessageId" | "forwardOfMessageId" | "uiState"
>;

interface DraftsState {
  held: boolean;
  drafts: Record<string, LocalDraft>;
}

type UiFrontier = { state: DraftsState; target: LocalDraft; stamp: number };
type UiFrame = { parent?: UiFrame; before: DraftsState; after: DraftsState; target: LocalDraft; stamp?: number; frontier?: UiFrontier; read?: AckRead; closed?: boolean };
type UiReceipt = { cursor?: UiFrame; close: UiFrame; frontier: UiFrontier };
let uiFrame: UiFrame | undefined, notificationStamp = 0;

export const useDrafts = create<DraftsState>(() => ({ drafts: {}, held: false }));
// First observer: nested native Zustand deliveries see live state, but retain their original previous state.
useDrafts.subscribe((state, previous) => {
  if (!uiFrame) return;
  const stamp = ++notificationStamp;
  if (uiFrame.stamp === undefined && state === uiFrame.after && previous === uiFrame.before) {
    uiFrame.stamp = stamp;
    uiFrame.frontier = { state, target: uiFrame.target, stamp };
  }
});

let changeVersion = 0;
let presentationNavigation = 0;
const pendingHydration = new Set<Set<string>>();
const identityOf = (d: Pick<LocalDraft, "id" | "generation">) => `${d.id}:${d.generation ?? ""}`;
function retireHydrationIdentity(d: LocalDraft): void {
  if (d.id !== null) for (const excluded of pendingHydration) excluded.add(identityOf(d));
}
/** Constant-time fence for page transitions, including coalesced editor changes. */
export const draftChangeVersion = (): number => changeVersion;

let pendingWork = 0, holds = 0, holdRevision = 0;
let holdFocus: HTMLElement | null = null;
export const draftEditsHeld = (): boolean => holds > 0;
export const draftHoldRevision = (): number => holdRevision;
export const draftWorkPending = (): boolean => pendingWork > 0 || Object.values(useDrafts.getState().drafts).some((d) => d.sending);

/** Accepted async intent must finish before shutdown can freeze and acknowledge its fields. */
export function beginDraftWork(): (() => void) | null {
  if (draftEditsHeld()) return null;
  pendingWork++; changeVersion++;
  let done = false;
  return () => { if (!done) { done = true; pendingWork--; changeVersion++; } };
}

const inputEvents = ["beforeinput", "keydown", "pointerdown", "click", "paste", "cut", "drop", "compositionstart"];
const holdInput = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };

/** A request-scoped lease; release never rebuilds or moves the editor/selection. */
export function acquireDraftHold(): (() => void) | null {
  if (draftWorkPending()) return null;
  if (++holds === 1) {
    holdRevision++;
    holdFocus = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof document !== "undefined") for (const type of inputEvents) document.addEventListener(type, holdInput, true);
    useDrafts.setState({ held: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) {
      if (typeof document !== "undefined") for (const type of inputEvents) document.removeEventListener(type, holdInput, true);
      useDrafts.setState({ held: false });
      const focus = holdFocus; holdFocus = null;
      if (focus && typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => {
        if (!draftEditsHeld() && focus.isConnected && (document.activeElement === document.body || document.activeElement === focus)) focus.focus({ preventScroll: true });
      });
    }
  };
}

/** IME text is accepted work until composition ends; never ACK an unfinished composition. */
export function trackDraftComposition(): void {
  let finish: (() => void) | null = null;
  document.addEventListener("compositionstart", () => { finish ??= beginDraftWork(); }, true);
  document.addEventListener("compositionend", () => { finish?.(); finish = null; }, true);
}

const get = (key: string): LocalDraft | undefined => useDrafts.getState().drafts[key];
const put = (d: LocalDraft) => useDrafts.setState((s) => ({ drafts: { ...s.drafts, [d.key]: d } }));
const drop = (key: string) =>
  useDrafts.setState((s) => {
    const { [key]: _, ...rest } = s.drafts;
    return { drafts: rest };
  });

// ───────────────────────────── pure helpers ─────────────────────────────

/**
 * Recipients as typed, for saving: everything, unfinished addresses too
 * ("bob@" must survive a reload), `auto` on the ones Terno filled in.
 */
export function recipients(text: string, auto: readonly string[]): DraftAddress[] {
  const autoSet = new Set(auto.map((e) => e.toLowerCase()));
  return parseAddressList(text).map((a) => (autoSet.has(a.email.toLowerCase()) ? { ...a, auto: true as const } : a));
}

/** Recipients for sending: valid addresses only (sendDraft refuses to send when anything typed isn't one). */
export function validRecipients(text: string): Address[] {
  return parseAddressList(text).filter((a) => isValidEmail(a.email));
}

/** The signature block appended below what is written (the "-- " line marks it, so clients can fold it). */
export function signatureBlock(signature: string): string {
  const sig = signature.replace(/\s+$/, "");
  return sig ? `-- \n${sig}` : "";
}

/** What is sent: what the user wrote, the From account's signature, then the quoted original when it is kept. */
export function sendBody(d: Pick<LocalDraft, "bodyText" | "quotedText" | "includeQuote">, signature = ""): string {
  const parts = [d.bodyText.replace(/\s+$/, ""), signatureBlock(signature)].filter(Boolean);
  const body = parts.join("\n\n");
  return d.includeQuote && d.quotedText ? `${body}\n\n${d.quotedText}` : body;
}

/** sendBody's HTML twin (plan 16): the written part's mail HTML (trailing empty lines dropped), the signature, the quote. */
export function sendHtml(bodyHtml: string, d: Pick<LocalDraft, "quotedText" | "includeQuote">, signature = "", quotedHtml?: string): string {
  const body = bodyHtml.replace(/(<div><br><\/div>)+$/, "");
  let html = [body, signatureHtml(signature)].filter(Boolean).join(GAP);
  if (d.includeQuote && d.quotedText) html += (html ? GAP : "") + (quotedHtml ?? textToHtml(d.quotedText));
  return emailDocument(html);
}

/** A draft as the backend stored it, in the renderer's shape. */
export function fromServer(d: Draft): LocalDraft {
  const text = (list: DraftAddress[]) => formatAddressList(list.map(({ name, email }) => ({ name, email })));
  return {
    key: `srv-${d.id}`,
    id: d.id,
    revision: d.revision,
    generation: d.generation,
    status: "saved",
    localRev: 0,
    savedRev: 0,
    accountId: d.accountId,
    threadId: d.threadId,
    showSourceContext: d.showSourceContext ?? false,
    ...(d.showSourceContext ? { sourceContextThreadId: d.presentationThreadId ?? null } : {}),
    mode: d.mode,
    toText: text(d.to),
    ccText: text(d.cc),
    bccText: text(d.bcc),
    auto: { to: d.to.filter((a) => a.auto).map((a) => a.email), cc: d.cc.filter((a) => a.auto).map((a) => a.email), bcc: d.bcc.filter((a) => a.auto).map((a) => a.email) },
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml ?? "",
    attachments: d.attachments ?? [],
    attachmentOwner: Boolean(d.attachments?.length),
    quotedText: d.quotedText,
    includeQuote: d.includeQuote,
    replyContext: d.replyContext ?? null,
    inReplyToMessageId: d.inReplyToMessageId,
    forwardOfMessageId: d.forwardOfMessageId,
    uiState: d.uiState,
    updatedAt: d.updatedAt,
    sending: false,
    bodyVersion: 0,
    canonical: false,
    tooLong: false,
  };
}

/** A draft's content, without its identity or save state (its body as the editor has it now). */
export function fieldsOf(d: LocalDraft): DraftFields {
  const cur = materialize(d.key) ?? d;
  const { showSourceContext, attachments, accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, bodyHtml, quotedText, includeQuote, replyContext, inReplyToMessageId, forwardOfMessageId, uiState } = cur;
  return { showSourceContext, attachments, accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, bodyHtml, quotedText, includeQuote, replyContext, inReplyToMessageId, forwardOfMessageId, uiState };
}

// ───────────────────────────── the editor's body ─────────────────────────────

/** What the editor gives for a draft's body: mail HTML ('' when empty) and its plain text, from one document. */
export type BodyReader = () => { html: string; text: string; editor?: { state: unknown; doc: object } };
interface BodySource {
  read: BodyReader;
  dirty: boolean;
  editVersion: number;
  failed: boolean;
  detached: boolean;
  /** its HTML comes from the schema (the editor's): a stand-in carrying a stored body isn't, and is re-read before sending */
  canonical: boolean;
  retained?: { state: unknown; version: number };
  owner?: object;
  certificate?: BodyCertificate;
}
const sources = new Map<string, BodySource>();

/** The same eight kept editor states; no ProseMirror code enters the draft module. */
export interface KeptEditorBody { readonly state: unknown; readonly version: number; readonly doc: object }
type KeptBody = KeptEditorBody & { certificate?: BodyCertificate };
type BodyCertificate = { origin: "raw" | "materialized"; authority?: LocalDraft; state?: unknown; doc?: object; owner?: object; source?: BodySource; version: number; entry?: KeptBody; read?: AckRead; valid: boolean };
type BodyRead = { phase: "attached" | "parked" | "raw"; certificate?: BodyCertificate; authority?: LocalDraft; entry?: KeptBody };
const keptBodies = new Map<string, KeptBody>();

function invalidateCertificate(certificate: BodyCertificate | undefined): void {
  if (!certificate) return;
  const read = certificate.read;
  if (certificate.source?.certificate === certificate) certificate.source.certificate = undefined;
  if (certificate.entry?.certificate === certificate) certificate.entry.certificate = undefined;
  certificate.valid = false; certificate.read = undefined; certificate.authority = undefined;
  certificate.source = undefined; certificate.entry = undefined; certificate.state = undefined; certificate.doc = undefined; certificate.owner = undefined;
  if (read) endDraftAckRead(read);
}
function validCertificate(c: BodyCertificate): boolean {
  const d = c.authority;
  return !!d && c.valid && c.doc !== undefined && get(d.key) === d &&
    (c.source ? sources.get(d.key) === c.source && c.source.certificate === c && c.source.owner === c.owner && c.source.editVersion === c.version && !c.source.dirty && !c.source.failed && !c.source.detached
      : !!c.entry && keptBodies.get(d.key) === c.entry && c.entry.certificate === c && !sources.has(d.key) && c.entry.doc === c.doc && c.entry.state === c.state && c.entry.version === d.bodyVersion);
}
function bodyCertificate(key: string): BodyCertificate | undefined { return sources.get(key)?.certificate ?? keptBodies.get(key)?.certificate; }
function advanceBodyAuthority(before: LocalDraft, after: LocalDraft, identity = false): void {
  const c = bodyCertificate(before.key);
  if (!c) return;
  if (!validCertificate(c) || c.authority !== before || before.bodyText !== after.bodyText || before.bodyHtml !== after.bodyHtml || before.bodyVersion !== after.bodyVersion || before.canonical !== after.canonical || (!identity && (before.id !== after.id || before.generation !== after.generation)) || after.recovery || after.sending || after.status === "error") { invalidateCertificate(c); return; }
  c.authority = after;
}
export function keepEditorBody(key: string, state: unknown, version: number, doc: object): KeptEditorBody {
  const old = keptBodies.get(key); if (old) invalidateCertificate(old.certificate);
  const entry: KeptBody = { state, version, doc };
  keptBodies.delete(key); keptBodies.set(key, entry);
  if (keptBodies.size > 8) forgetEditorBody(keptBodies.keys().next().value!);
  return entry;
}
export function keptEditorBody(key: string, version: number): KeptEditorBody | undefined {
  const entry = keptBodies.get(key); return entry?.version === version ? entry : undefined;
}
export function forgetEditorBody(key: string): boolean {
  const entry = keptBodies.get(key); if (entry) invalidateCertificate(entry.certificate);
  return keptBodies.delete(key);
}

/** A synchronous constructor is classified only after its actual state/doc branch exists. */
export interface EditorBodyConstruction {
  supplyState(origin: "raw" | "kept" | "other", state: unknown, doc: object, entry?: KeptEditorBody): void;
  changed(): void;
  close(complete: boolean): void;
}
type BodyConstruction = EditorBodyConstruction & { key: string; owner: object; authority?: LocalDraft; prior?: BodySource; priorVersion?: number; parent?: BodyConstruction; state?: unknown; doc?: object; certificate?: BodyCertificate; entry?: KeptBody; origin?: "raw" | "kept" | "other"; supplied: boolean; modified: boolean; active: boolean; attached?: BodySource; read?: AckRead };
let bodyConstruction: BodyConstruction | undefined;
function constructing(key: string): boolean { for (let c = bodyConstruction; c; c = c.parent) if (c.key === key) return true; return false; }
function currentAckRead(key: string): AckRead | undefined { return writers.get(key)?.ackRead ?? (noWriterRead?.key === key ? noWriterRead : undefined); }
function validConstruction(c: BodyConstruction): boolean {
  return c.active && c.supplied && !c.modified && c.origin !== "other" && !!c.authority && get(c.key) === c.authority && !draftEditsHeld() && !c.authority.sending && !c.authority.recovery && sources.get(c.key) === c.prior && c.prior?.editVersion === c.priorVersion && !c.prior?.dirty && !c.prior?.failed && !c.prior?.detached && !!c.certificate?.valid && c.certificate.authority === c.authority && c.certificate.doc === c.doc &&
    (c.origin === "raw" || !!c.entry && keptBodies.get(c.key) === c.entry && c.entry.certificate === c.certificate && c.entry.state === c.state && c.entry.doc === c.doc);
}
export function enterEditorBodyConstruction(key: string, owner: object): EditorBodyConstruction {
  const prior = sources.get(key);
  const c: BodyConstruction = {
    key, owner, authority: get(key), prior, priorVersion: prior?.editVersion, parent: bodyConstruction, read: currentAckRead(key), active: true, supplied: false, modified: false,
    supplyState(origin, state, doc, entry) {
      if (!c.active || c.supplied) return;
      c.supplied = true; c.origin = origin; c.state = state; c.doc = doc;
      if (!c.authority || get(key) !== c.authority || draftEditsHeld() || c.authority.sending || c.authority.recovery) return;
      if (origin === "raw") c.certificate = { origin: "raw", authority: c.authority, state, doc, owner, version: 0, valid: true };
      else if (origin === "kept" && entry && keptBodies.get(key) === entry && entry.state === state && entry.doc === doc && entry.version === c.authority.bodyVersion) {
        const cached = entry as KeptBody;
        if (cached.certificate && validCertificate(cached.certificate)) { c.entry = cached; c.certificate = cached.certificate; }
      }
    },
    changed() {
      if (!c.active) return;
      c.modified = true;
      if (c.read) endDraftAckRead(c.read);
      if (!c.certificate?.source || c.certificate.source === c.attached) invalidateCertificate(c.certificate);
    },
    close(complete) {
      if (!c.active) return;
      c.active = false;
      if (!complete || !c.attached || c.modified) {
        if (c.read) endDraftAckRead(c.read);
        if (!c.certificate?.source || c.certificate.source === c.attached) invalidateCertificate(c.certificate);
      }
      if (bodyConstruction === c) bodyConstruction = c.parent;
      c.authority = undefined; c.prior = undefined; c.state = undefined; c.doc = undefined; c.certificate = undefined; c.entry = undefined; c.read = undefined; c.attached = undefined; c.parent = undefined;
    },
  };
  bodyConstruction = c;
  return c;
}
function adoptEditorSource(c: BodyConstruction | undefined, source: BodySource): void {
  if (!c || !validConstruction(c)) return;
  const certificate = c.certificate!;
  if (certificate.entry?.certificate === certificate) certificate.entry.certificate = undefined;
  certificate.entry = undefined; certificate.state = c.state; certificate.source = source; certificate.owner = c.owner; certificate.version = source.editVersion;
  source.owner = c.owner; source.certificate = certificate; c.attached = source;
}

export interface BodyCheckpoint { readonly key: string; readonly version: number; readonly source: BodySource; readonly retained: NonNullable<BodySource["retained"]> }

export function bodyCheckpoint(key: string): BodyCheckpoint | undefined {
  const draft = get(key), source = sources.get(key), retained = source?.retained;
  return draft && source?.detached && retained && retained.version === draft.bodyVersion ? { key, version: draft.bodyVersion, source, retained } : undefined;
}

export function validBodyCheckpoint(checkpoint: BodyCheckpoint): boolean {
  const draft = get(checkpoint.key), source = sources.get(checkpoint.key);
  return Boolean(draft && draft.bodyVersion === checkpoint.version && source === checkpoint.source && source.detached && source.retained === checkpoint.retained);
}

/**
 * The editor of a draft takes its body: `changed()` after each document change
 * (an edit: dirty, saved later), `dispose()` when it unmounts (what it has is
 * written to the draft first). A source of a draft that is gone does nothing.
 */
export function attachBody(key: string, read: BodyReader, options: { canonical?: boolean; checkpoint?: BodyCheckpoint; editor?: EditorBodyConstruction } = {}): { changed(): void; reset(editor?: EditorBodyConstruction): void; dispose(snapshot?: { read: BodyReader; state: unknown; version: number; editor?: KeptEditorBody }): void } {
  if (options.checkpoint && (options.checkpoint.key !== key || !validBodyCheckpoint(options.checkpoint))) throw new Error("Draft checkpoint is no longer available");
  const prior = sources.get(key), pending = currentAckRead(key), c = options.editor as BodyConstruction | undefined;
  if (c && (!c.active || c.key !== key || c.authority !== get(key) || c.prior !== prior || c.priorVersion !== prior?.editVersion)) {
    if (c.read) endDraftAckRead(c.read);
    throw new Error(t("compose.readChanged"));
  }
  const prepared = c && validConstruction(c) ? c : undefined;
  const body = pending?.body;
  const preserve = pending && prepared && pending === prepared.read && readDraftAck(pending) !== undefined && body &&
    ((body.phase === "raw" && prepared.origin === "raw" && !prior && body.authority === prepared.authority) ||
      (body.phase === "parked" && prepared.origin === "kept" && !prior && body.certificate === prepared.certificate && body.entry === prepared.entry));
  if (pending && !preserve) endDraftAckRead(pending);
  const oldCertificate = bodyCertificate(key);
  if (oldCertificate !== prepared?.certificate) invalidateCertificate(oldCertificate);
  const source: BodySource = { read, dirty: prior?.dirty ?? false, editVersion: 0, failed: prior?.failed ?? false, detached: false, canonical: options.canonical ?? true };
  const actualEditor = c?.active && c.key === key && c.authority === get(key) && c.prior === prior;
  if (actualEditor) source.owner = c.owner;
  adoptEditorSource(prepared, source);
  sources.set(key, source);
  if (actualEditor) c.attached = source;
  if (preserve && pending?.current && prepared?.certificate && source.certificate === prepared.certificate) {
    pending.source = source; pending.version = source.editVersion;
    if (pending.phase === "forward" && body?.phase === "raw") {
      pending.body = undefined;
      if (source.certificate.read === pending) source.certificate.read = undefined;
    } else {
      pending.body = { phase: "attached", certificate: source.certificate };
      source.certificate.read = pending;
    }
  }
  const attached = {
    changed() {
      if (sources.get(key) !== source || source.detached) return;
      const d = get(key);
      if (!d || d.sending || draftEditsHeld()) return;
      invalidateCertificate(source.certificate);
      invalidateNoWriterRead(key);
      changeVersion++;
      source.editVersion++;
      const w = writer(key), proof = w.ackRead;
      if (proof?.phase === "forward" && proof.source === source && proof.current === d && !w.publishing) proof.version = source.editVersion;
      else if (proof) endDraftAckRead(proof);
      if (source.dirty && d.localRev > d.savedRev) return schedule(key);
      source.dirty = true;
      const changed: LocalDraft = { ...d, localRev: d.localRev + 1, status: d.status === "saving" ? "saving" : "dirty", updatedAt: now(), tooLong: false };
      publishWriter(w, d, changed, w.ackRead?.phase === "forward");
      schedule(key);
    },
    reset(editor?: EditorBodyConstruction) {
      if (sources.get(key) !== source || source.detached) return;
      invalidateCertificate(source.certificate);
      invalidateNoWriterRead(key);
      source.editVersion++;
      const proof = writers.get(key)?.ackRead; if (proof) endDraftAckRead(proof);
      source.dirty = false;
      const construction = editor as BodyConstruction | undefined;
      if (construction?.prior === source && construction.owner === source.owner && construction.origin === "raw") {
        construction.priorVersion = source.editVersion;
        adoptEditorSource(construction, source);
      }
    },
    dispose(snapshot?: { read: BodyReader; state: unknown; version: number; editor?: KeptEditorBody }) {
      if (sources.get(key) !== source || source.detached) return;
      const proof = currentAckRead(key), certificate = source.certificate;
      const entry = snapshot?.editor as KeptBody | undefined;
      const owned = !!certificate && validCertificate(certificate) && !!entry && keptBodies.get(key) === entry && entry.state === snapshot?.state && entry.version === snapshot?.version && entry.doc === certificate.doc;
      const preserve = owned && proof?.body?.phase === "attached" && proof.body.certificate === certificate && readDraftAck(proof) !== undefined;
      if (proof && !preserve) endDraftAckRead(proof);
      let unread = source.failed && source.dirty;
      if (!unread) { try { materialize(key); } catch { unread = true; } }
      if (unread) {
        invalidateCertificate(source.certificate);
        if (snapshot) {
          source.read = snapshot.read;
          source.retained = { state: snapshot.state, version: snapshot.version };
        }
        source.detached = true;
        return;
      }
      const currentCertificate = source.certificate;
      if (entry && snapshot && keptBodies.get(key) === entry && currentCertificate && validCertificate(currentCertificate) && entry.state === snapshot.state && entry.version === get(key)?.bodyVersion && entry.doc === currentCertificate.doc) {
        currentCertificate.source = undefined; currentCertificate.state = entry.state; currentCertificate.entry = entry; entry.certificate = currentCertificate;
        sources.delete(key);
        if (preserve && proof?.current && currentCertificate === certificate) {
          proof.source = undefined; proof.version = 0;
          proof.body = { phase: "parked", certificate: currentCertificate, entry };
        }
      } else { invalidateCertificate(currentCertificate); sources.delete(key); }
    },
  };
  if (actualEditor && c.modified) attached.changed();
  return attached;
}

/** A failed editor disposal retains its exact state until that editor takes ownership again. */
export function retainedBodyState<T>(key: string, version: number): T | undefined {
  const retained = sources.get(key)?.retained;
  return retained?.version === version ? retained.state as T : undefined;
}

/** Writes a dirty editor body into the draft (same revision: the edit was counted when it was made). */
export function materialize(key: string): LocalDraft | undefined {
  const d = get(key);
  const source = sources.get(key);
  if (!d || !source?.dirty) return d;
  const version = source.editVersion, detached = source.detached;
  const materializingWriter = writers.get(key);
  const materializingOperation = materializingWriter?.operation;
  const materializingRead = materializingWriter?.ackRead;
  const materializingCertificate = source.certificate;
  const fail = (error: unknown): never => {
    invalidateCertificate(materializingCertificate);
    if (materializingRead) endDraftAckRead(materializingRead);
    if (sources.get(key) === source && source.editVersion === version && source.detached === detached && source.dirty && get(key)?.bodyVersion === d.bodyVersion) {
      source.failed = true; source.dirty = true;
      if (materializingWriter && writers.get(key) === materializingWriter && materializingWriter.operation === materializingOperation && materializingWriter.timer) {
        clearTimeout(materializingWriter.timer); materializingWriter.timer = null;
      }
    }
    throw error;
  };
  let body: ReturnType<BodyReader>;
  try { body = source.read(); } catch (error) { return fail(error); }
  if (sources.get(key) !== source || source.detached !== detached || source.editVersion !== version || get(key) !== d) return fail(new Error(t("compose.readChanged")));
  const { html, text } = body;
  const next = { ...d, bodyHtml: html, bodyText: text, canonical: source.canonical };
  const w = writers.get(key);
  try {
    if (w) publishWriter(w, d, next, w.ackRead?.phase === "forward" && w.ackRead.source === source && w.ackRead.version === version); else put(next);
  } catch (error) {
    invalidateCertificate(materializingCertificate);
    if (materializingRead) endDraftAckRead(materializingRead);
    throw error;
  }
  if (sources.get(key) !== source || source.detached !== detached || source.editVersion !== version || get(key) !== next) return fail(new Error(t("compose.readChanged")));
  source.dirty = false;
  source.failed = false;
  if (source.owner && body.editor) {
    invalidateCertificate(source.certificate);
    source.certificate = { origin: "materialized", authority: next, state: body.editor.state, doc: body.editor.doc, owner: source.owner, source, version, valid: true };
  }
  return next;
}

function materializeOrCurrent(key: string): LocalDraft | undefined {
  if (sources.get(key)?.failed) return get(key);
  try { return materialize(key); } catch { return get(key); }
}

/** Has the user written anything worth keeping? A reply only prefilled by Terno isn't saved. */
export const authored = (d: LocalDraft): boolean => d.localRev > 0 || d.id !== null;

// ───────────────────────────── the writer ─────────────────────────────

const DEBOUNCE_MS = 800;
const MAX_WAIT_MS = 5000;
const RETRY_MS = [1000, 2000, 5000];

interface Writer {
  timer: ReturnType<typeof setTimeout> | null;
  /** the save in flight */
  inflight: Promise<void> | null;
  /** when the oldest unsaved edit was made (for the 5 s ceiling) */
  dirtySince: number | null;
  attempts: number;
  operation: number;
  stopping: "send" | "discard" | null;
  ackRead?: AckRead;
  publishing?: number;
}
const writers = new Map<string, Writer>();
const writer = (key: string): Writer => {
  let w = writers.get(key);
  if (!w) { invalidateNoWriterRead(key); writers.set(key, (w = { timer: null, inflight: null, dirtySince: null, attempts: 0, operation: 0, stopping: null })); }
  return w;
};

declare const ackReadBrand: unique symbol;
export type DraftAckRead = { readonly [ackReadBrand]: true };
type AckRead = DraftAckRead & { key: string; writer?: Writer; noWriter?: true; current?: LocalDraft; source?: BodySource; version: number; phase: "strict" | "forward"; ui?: UiReceipt; body?: BodyRead; edge?: { before: LocalDraft; after: LocalDraft }; stop?: () => void };
type AckAdmission = { kind: "proof"; proof: DraftAckRead } | { kind: "no-writer"; continuity: DraftAckRead } | { kind: "refused" };
let noWriterRead: AckRead | undefined;
function invalidateNoWriterRead(key: string): void { if (noWriterRead?.key === key) endDraftAckRead(noWriterRead); }

/** A conversion may observe only exact, writer-owned acknowledgement publications. */
export function beginDraftAckRead(expected: LocalDraft): AckAdmission {
  const w = writers.get(expected.key), source = sources.get(expected.key);
  if (constructing(expected.key) || draftEditsHeld() || expected.sending || expected.recovery || get(expected.key) !== expected || source?.dirty || source?.failed || source?.detached || w?.publishing || w?.stopping) return { kind: "refused" };
  const read = beginAckRead(expected, "strict", !w);
  if (!read) return { kind: "refused" };
  return w ? { kind: "proof", proof: read } : { kind: "no-writer", continuity: read };
}
/** Only a leased conversion can reserve a certified editor arrival/departure. */
export function beginComposeBodyAckRead(expected: LocalDraft): AckAdmission {
  const admission = beginDraftAckRead(expected);
  if (admission.kind === "refused") return admission;
  const read = (admission.kind === "proof" ? admission.proof : admission.continuity) as AckRead;
  const source = sources.get(expected.key), certificate = bodyCertificate(expected.key);
  if (certificate && validCertificate(certificate)) {
    read.body = { phase: source ? "attached" : "parked", certificate, entry: certificate.entry };
    certificate.read = read;
  } else if (!source && !keptBodies.has(expected.key)) read.body = { phase: "raw", authority: expected };
  return admission;
}
function validBodyRead(read: AckRead): boolean {
  const body = read.body;
  if (!body) return true;
  if (body.phase === "raw") return body.authority === read.current && !sources.has(read.key) && !keptBodies.has(read.key);
  return !!body.certificate && validCertificate(body.certificate) && body.certificate.read === read && (body.phase === "attached" ? body.certificate.source === read.source : body.entry === body.certificate.entry && !read.source);
}
function beginAckRead(expected: LocalDraft, phase: AckRead["phase"], allowNoWriter = false): DraftAckRead | undefined {
  const w = writers.get(expected.key), source = sources.get(expected.key);
  if ((!w && !allowNoWriter) || w?.publishing || w?.stopping || draftEditsHeld() || expected.sending || expected.recovery || get(expected.key) !== expected || source?.dirty || source?.failed || source?.detached) return;
  const frontier = uiFrame?.frontier;
  if (uiFrame && (!frontier || frontier.state !== useDrafts.getState() || frontier.target !== expected || frontier.stamp !== notificationStamp)) return;
  if (w?.ackRead) endDraftAckRead(w.ackRead);
  if (!w && noWriterRead) endDraftAckRead(noWriterRead);
  const read = { key: expected.key, writer: w, ...(!w ? { noWriter: true as const } : {}), current: expected, source, version: source?.editVersion ?? 0, phase } as AckRead;
  if (w) w.ackRead = read; else noWriterRead = read;
  if (uiFrame && frontier) { read.ui = { cursor: uiFrame, close: uiFrame, frontier }; uiFrame.read = read; }
  read.stop = useDrafts.subscribe((state, previous) => {
    const current = read.current, edge = read.edge;
    if (state.held || previous.held || !current) { endDraftAckRead(read); return; }
    const next = state.drafts[read.key], before = previous.drafts[read.key];
    if (read.ui) {
      const { cursor, frontier } = read.ui;
      if (!validUiReceipt(read) || !cursor || cursor.closed || cursor.stamp === undefined || state !== frontier.state || previous !== cursor.before) { endDraftAckRead(read); return; }
      read.ui.cursor = cursor.parent;
      return;
    }
    if (next === current && before === current) return;
    if (!edge || next !== edge.after || before !== edge.before) endDraftAckRead(read);
  });
  if (get(expected.key) !== expected || writers.get(expected.key) !== w || sources.get(expected.key) !== source || (!w && noWriterRead !== read)) { endDraftAckRead(read); return; }
  return read;
}
export function beginForwardEmptyOwnerRead(token: DraftAckRead): DraftAckRead | undefined {
  const read = token as AckRead, current = readDraftAck(read);
  if (!current || read.ui || constructing(read.key) || read.phase !== "strict" || current.attachments?.length || current.attachmentOwner) return;
  return exchangeForwardRead(read, current, "forward");
}
/** Seals only the exact empty-owner author read after its fully saved transition. */
export function sealForwardEmptyOwnerRead(token: DraftAckRead): DraftAckRead | undefined {
  const read = token as AckRead, current = readDraftAck(read);
  if (!current || read.ui || constructing(read.key) || read.phase !== "forward" || current.attachments?.length || current.attachmentOwner || current.savedRev !== current.localRev) return;
  const pristine = current.id === null && current.status === "clean" && current.localRev === 0 && !authored(current);
  if (current.status !== "saved" && !pristine) return;
  return exchangeForwardRead(read, current, "strict");
}
function exchangeForwardRead(read: AckRead, current: LocalDraft, phase: AckRead["phase"]): DraftAckRead | undefined {
  const raw = read.body?.phase === "raw" ? read.body : undefined;
  const next = beginAckRead(current, phase) as AckRead | undefined;
  if (!next) return;
  if (raw) next.body = raw;
  if (readDraftAck(next) !== current) { endDraftAckRead(next); return; }
  return next;
}
export function readDraftAck(token: DraftAckRead): LocalDraft | undefined {
  const read = token as AckRead, w = read.writer, source = sources.get(read.key);
  if (!validUiReceipt(read) || !validBodyRead(read) || (!w && (!read.noWriter || noWriterRead !== read)) || (w && w.ackRead !== read) || writers.get(read.key) !== w || !read.current || get(read.key) !== read.current || source !== read.source || (source && (source.editVersion !== read.version || source.dirty || source.failed || source.detached)) || w?.stopping || draftEditsHeld() || read.current.sending || read.current.recovery) { endDraftAckRead(read); return; }
  return read.current;
}
export function endDraftAckRead(token: DraftAckRead): void {
  const read = token as AckRead, w = read.writer;
  read.stop?.(); read.stop = undefined;
  if (w?.ackRead === read) w.ackRead = undefined;
  if (noWriterRead === read) noWriterRead = undefined;
  if (read.body?.certificate?.read === read) read.body.certificate.read = undefined;
  read.body = undefined;
  if (read.ui?.close.read === read) read.ui.close.read = undefined;
  read.ui = undefined;
  read.writer = undefined; read.current = undefined; read.source = undefined; read.edge = undefined;
}

function validUiReceipt(read: AckRead): boolean {
  const ui = read.ui;
  return !ui || (!ui.close.closed && ui.frontier.stamp === notificationStamp && ui.frontier.state === useDrafts.getState() && ui.frontier.target === read.current);
}

function publishWriter(w: Writer, before: LocalDraft, after: LocalDraft, admitted: boolean, identity = false): void {
  advanceBodyAuthority(before, after, identity);
  const read = w.ackRead;
  if (read && (!admitted || w.publishing || read.current !== before || get(before.key) !== before)) endDraftAckRead(read);
  const allowed = w.ackRead;
  if (allowed) {
    if (allowed.body?.phase === "raw" && allowed.body.authority === before) allowed.body.authority = after;
    allowed.edge = { before, after }; allowed.current = after;
  }
  w.publishing = (w.publishing ?? 0) + 1;
  try { put(after); }
  finally {
    w.publishing--;
    if (allowed) {
      allowed.edge = undefined;
      if (get(after.key) !== after) endDraftAckRead(allowed);
    }
  }
}

type Call = (method: "drafts.save" | "drafts.delete", params: unknown) => Promise<unknown>;
let call: Call = (method, params) => client.call(method as "drafts.save", params as never) as Promise<unknown>;
let now = () => Date.now();
/** Tests: a fake backend and clock. */
export function setDraftTransport(c: Call, clock?: () => number): void {
  call = c;
  if (clock) now = clock;
}

let seq = 0;
const newKey = () => `local-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** A new draft (not saved until the user writes something). Returns its key. */
export function createDraftWithReceipt(fields: DraftFields): { key: string; created: LocalDraft } {
  if (draftEditsHeld()) throw new Error("Draft editing is held for shutdown");
  changeVersion++;
  const key = newKey();
  const created: LocalDraft = { key, id: null, revision: 0, status: "clean", localRev: 0, savedRev: 0, updatedAt: now(), sending: false, bodyVersion: 0, canonical: false, tooLong: false, ...fields };
  put(created);
  return { key, created };
}
export function createDraft(fields: DraftFields): string { return createDraftWithReceipt(fields).key; }

export const draftSenderLocked = (d: LocalDraft): boolean => Boolean(d.attachments?.length || d.attachmentOwner);

/** An edit: the content changes now, the save follows (800 ms after the last edit, ≤ 5 s while typing). */
export function editDraft(key: string, patch: Partial<DraftFields>): boolean {
  return editDraftFields(key, patch, false);
}
export function editDraftRecipients(key: string, field: "to" | "cc" | "bcc", text: string, authored: readonly string[]): boolean {
  const d = get(key);
  if (!d) return false;
  const auto = authored.length ? { ...d.auto, [field]: d.auto[field].filter((email) => !authored.includes(email.toLowerCase())) } : d.auto;
  return editDraftFields(key, { [`${field}Text`]: text, ...(auto !== d.auto ? { auto } : {}) }, true);
}
function editDraftFields(key: string, patch: Partial<DraftFields>, recipients: boolean): boolean {
  if (draftEditsHeld()) return false;
  // a body patch is compared with the body as the editor has it now
  const d = "bodyText" in patch || "bodyHtml" in patch ? materialize(key) : get(key);
  // nothing changes under a send in flight (it is sending what is there now)
  if (!d || d.sending) return false;
  if (patch.accountId !== undefined && patch.accountId !== d.accountId && draftSenderLocked(d)) return false;
  changeVersion++;
  const mode = patch.mode ?? d.mode;
  const sourceChanged = mode !== d.mode || (mode === "forward" ? patch.forwardOfMessageId !== undefined && patch.forwardOfMessageId !== d.forwardOfMessageId : patch.inReplyToMessageId !== undefined && patch.inReplyToMessageId !== d.inReplyToMessageId);
  const resetContext = patch.threadId !== undefined || sourceChanged || patch.showSourceContext === false;
  const bodyChanged = (patch.bodyText !== undefined && patch.bodyText !== d.bodyText) || (patch.bodyHtml !== undefined && patch.bodyHtml !== d.bodyHtml);
  const bodySource = bodyChanged ? sources.get(key) : undefined;
  const bodySourceVersion = bodySource?.editVersion;
  const next: LocalDraft = {
    ...d,
    ...patch,
    ...(resetContext ? { departedThreadId: undefined, presentationThreadId: patch.showSourceContext && patch.threadId === null ? draftPresentationThread(d) ?? undefined : undefined, sourceContextThreadId: undefined, presentationExpired: false, presentationEpoch: (d.presentationEpoch ?? 0) + 1 } : {}),
    ...((sourceChanged || patch.threadId === null || mode === "new") && patch.showSourceContext === undefined ? { showSourceContext: false } : {}),
    ...(patch.attachments?.length === 0 && d.recovery && (d.recovery.state === "missing" || d.recovery.state === "refused") ? { attachmentOwner: false } : {}),
    localRev: d.localRev + 1,
    status: d.status === "saving" ? "saving" : "dirty",
    updatedAt: now(),
    tooLong: false,
    ...(bodyChanged ? { bodyVersion: d.bodyVersion + 1, canonical: false } : {}),
  };
  const w = writer(key);
  if (w?.ackRead) {
    const allowed = w.ackRead.phase === "forward" && Object.keys(patch).every((field) => ["bodyText", "bodyHtml", "toText", "ccText", "bccText", "subject", "subjectEdited"].includes(field) || (recipients && field === "auto"));
    publishWriter(w, d, next, allowed);
  } else publishWriter(w, d, next, false);
  if (bodySource && sources.get(key) === bodySource && bodySource.editVersion === bodySourceVersion) {
    if (bodySource.retained) sources.delete(key);
    else bodySource.dirty = false;
  }
  schedule(key);
  return true;
}

/** UI state (open/collapsed) changes: saved with the draft, but not an authored edit. */
export function setDraftUi(key: string, uiState: LocalDraft["uiState"]): void {
  const d = get(key);
  if (draftEditsHeld() || !d || d.uiState === uiState) return;
  changeVersion++;
  const next = { ...d, uiState, ...(d.id !== null ? { localRev: d.localRev + 1, status: d.status === "saving" ? "saving" as const : "dirty" as const } : {}) };
  if (d.id !== null) writer(key);
  advanceBodyAuthority(d, next);
  const before = useDrafts.getState(), after = { ...before, drafts: { ...before.drafts, [key]: next } };
  const frame: UiFrame = { parent: uiFrame, before, after, target: next };
  uiFrame = frame;
  let complete = false;
  try {
    useDrafts.setState(after, true);
    complete = true;
  } finally {
    const read = frame.read;
    if (read?.ui?.close === frame) {
      if (!complete || !validUiReceipt(read) || read.ui.cursor === frame) endDraftAckRead(read);
      else if (frame.parent) { read.ui.close = frame.parent; frame.parent.read = read; }
      else read.ui = undefined;
    }
    if (complete && frame.parent && frame.frontier?.state === useDrafts.getState() && frame.frontier.stamp === notificationStamp && !draftEditsHeld()) frame.parent.frontier = frame.frontier;
    frame.closed = true; frame.read = undefined; frame.frontier = undefined;
    uiFrame = frame.parent;
  }
  if (d.id !== null) schedule(key);
}

function schedule(key: string): void {
  if (!get(key) || get(key)?.recovery || writers.get(key)?.stopping || sources.get(key)?.failed) return;
  const w = writer(key);
  w.dirtySince ??= now();
  if (w.timer) clearTimeout(w.timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now() - w.dirtySince)));
  w.timer = setTimeout(() => {
    w.timer = null;
    void save(key);
  }, wait);
}

/** Sends the current content unless a save is in flight (it re-saves when that one answers). */
function save(key: string, copy = false): Promise<void> {
  const current = get(key);
  if (!current || (current.recovery && !copy) || writers.get(key)?.stopping) return Promise.resolve();
  const w = writer(key);
  if (w.inflight) return w.inflight;
  // the editor's body, serialized once for this save (same document as the revision it saves)
  let d: LocalDraft | undefined;
  const savingSource = sources.get(key), savingVersion = savingSource?.editVersion, savingDetached = savingSource?.detached;
  const savingOperation = w.operation, savingTimer = w.timer;
  try { d = materialize(key); } catch {
    if (writers.get(key) !== w || w.operation !== savingOperation || sources.get(key) !== savingSource || !savingSource?.failed || !savingSource.dirty || savingSource.editVersion !== savingVersion || savingSource.detached !== savingDetached || get(key)?.bodyVersion !== current.bodyVersion) return Promise.resolve();
    if (w.timer === savingTimer) {
      if (savingTimer) clearTimeout(savingTimer);
      w.timer = null;
    }
    const failed = get(key);
    if (failed) { invalidateCertificate(bodyCertificate(key)); put({ ...failed, status: "error" }); }
    return Promise.resolve();
  }
  if (!d || !authored(d) || (!copy && d.savedRev === d.localRev)) return Promise.resolve();
  const rev = d.localRev;
  const operation = ++w.operation;
  const uncertain = d.recovery?.state === "unknown" || d.recovery?.uncertain;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  w.dirtySince = null;
  const saving: LocalDraft = { ...d, ...(copy ? { recovery: { state: "copying" as const, ...(uncertain ? { uncertain: true as const } : {}) } } : {}), status: "saving", attachmentOwner: d.attachmentOwner || Boolean(d.attachments?.length) };
  const params = {
    id: copy ? undefined : d.id ?? undefined,
    generation: copy ? undefined : d.generation,
    baseRevision: !copy && d.id !== null ? d.revision : undefined,
    accountId: d.accountId,
    threadId: d.threadId,
    mode: d.mode,
    to: recipients(d.toText, d.auto.to),
    cc: recipients(d.ccText, d.auto.cc),
    bcc: recipients(d.bccText, d.auto.bcc),
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml,
    attachments: d.attachments ?? [],
    quotedText: d.quotedText,
    includeQuote: d.includeQuote,
    replyContext: d.replyContext ?? null,
    inReplyToMessageId: d.inReplyToMessageId,
    forwardOfMessageId: d.forwardOfMessageId,
    showSourceContext: d.showSourceContext ?? false,
    uiState: d.uiState,
  };
  if (get(key) !== d || writers.get(key) !== w || w.operation !== operation) return Promise.resolve();
  publishWriter(w, d, saving, !copy);
  if (get(key) !== saving || writers.get(key) !== w || w.operation !== operation) {
    if (writers.get(key) === w && w.operation === operation && !w.timer) schedule(key);
    return Promise.resolve();
  }
  w.inflight = call("drafts.save", params).then(
    (res) => {
      if (w.operation !== operation) return;
      w.inflight = null;
      w.attempts = 0;
      const cur = get(key);
      if (!cur) return;
      const saved = res as Draft | null;
      if (!saved) {
        if (copy) { invalidateCertificate(bodyCertificate(key)); put({ ...materializeOrCurrent(key)!, status: "error", recovery: { state: "unknown" } }); }
        else markDraftMissing(key);
        return;
      }
      const done = cur.localRev === rev;
      if (cur.id !== d.id || cur.generation !== d.generation) return;
      if (JSON.stringify(saved.replyContext ?? null) !== JSON.stringify(d.replyContext ?? null)) {
        invalidateCertificate(bodyCertificate(key));
        put({ ...cur, id: saved.id, generation: saved.generation, revision: saved.revision, status: "error", ...(copy ? { recovery: { state: "unknown" as const } } : {}) });
        return;
      }
      const sameContext = JSON.stringify(cur.replyContext ?? null) === JSON.stringify(d.replyContext ?? null) && cur.accountId === d.accountId && cur.threadId === d.threadId && cur.mode === d.mode && cur.inReplyToMessageId === d.inReplyToMessageId && cur.forwardOfMessageId === d.forwardOfMessageId && cur.showSourceContext === d.showSourceContext;
      const placement = draftPresentationThread(cur);
      const currentMount = cur.presentationEpoch === d.presentationEpoch;
      const context = sameContext
        ? { threadId: saved.threadId, mode: saved.mode, inReplyToMessageId: saved.inReplyToMessageId, forwardOfMessageId: saved.forwardOfMessageId,
            showSourceContext: saved.showSourceContext ?? false,
            ...(currentMount ? { sourceContextThreadId: saved.showSourceContext ? saved.presentationThreadId ?? null : undefined,
              ...(placement !== null && (saved.threadId !== placement || saved.mode === "new") ? { presentationThreadId: placement } : {}) } : {}) } : {};
      if (cur.id !== saved.id || cur.generation !== saved.generation) retireHydrationIdentity(cur);
      const acknowledged: LocalDraft = { ...cur, ...context, id: saved.id, generation: saved.generation, revision: saved.revision, savedRev: rev, recovery: undefined, status: done ? "saved" : "dirty", attachmentOwner: Boolean(saved.attachments?.length) };
      const identity = d.id === null ? saved.id != null && typeof saved.generation === "string" && saved.revision === 1 : saved.id === d.id && saved.generation === d.generation && saved.revision === d.revision + 1;
      const canonicalNull = d.id !== null && d.threadId === null && cur.threadId === null && saved.threadId === null && saved.accountId === cur.accountId &&
        d.showSourceContext === true && cur.showSourceContext === true && saved.showSourceContext === true && cur.mode !== "new" &&
        (cur.mode === "forward" ? cur.forwardOfMessageId : cur.inReplyToMessageId) !== null && !d.presentationExpired && !cur.presentationExpired &&
        typeof placement === "number" && draftPresentationThread(d) === placement && saved.presentationThreadId === placement &&
        (d.sourceContextThreadId === undefined || d.sourceContextThreadId === placement) && (cur.sourceContextThreadId === undefined || cur.sourceContextThreadId === placement);
      const source = JSON.stringify(saved.replyContext ?? null) === JSON.stringify(cur.replyContext ?? null) && saved.mode === cur.mode && saved.threadId === cur.threadId && saved.inReplyToMessageId === cur.inReplyToMessageId && saved.forwardOfMessageId === cur.forwardOfMessageId && (saved.showSourceContext ?? false) === (cur.showSourceContext ?? false) && (!saved.showSourceContext || (cur.threadId !== null && (saved.presentationThreadId ?? null) === placement) || canonicalNull);
      publishWriter(w, cur, acknowledged, !copy && sameContext && currentMount && identity && source, !copy && sameContext && currentMount && identity && source);
      if (!done && !w.stopping && !sources.get(key)?.failed) {
        const next = save(key);
        if (!copy) return next;
      }
    },
    (error: unknown) => {
      if (w.operation !== operation) return;
      w.inflight = null;
      const cur = copy ? materializeOrCurrent(key) : get(key);
      if (!cur) return;
      if (copy) {
        const e = error as { code?: string; details?: { reason?: string } } | null;
        const refused = e?.code === "BAD_REQUEST" || e?.code === "NOT_FOUND" || e?.code === "STALE" || e?.code === "FORBIDDEN";
        const reason = Array.isArray(e?.details) && e.details.some((issue: { code?: string }) => issue?.code === "too_big") ? "size" : e?.details?.reason;
        const known = reason === "assets" || reason === "account" || reason === "context" || reason === "size" ? reason : "invalid";
        invalidateCertificate(bodyCertificate(key));
        put({ ...cur, ...(refused && !uncertain && !cur.attachments?.length ? { attachmentOwner: false } : {}), status: "error", tooLong: false, recovery: refused && !uncertain ? { state: "refused", reason: known } : { state: "unknown", ...(refused ? { reason: known } : {}) } });
        return;
      }
      // refused as invalid (past the size limits): trying again won't help until it changes; Retry stays
      if ((error as { code?: string } | null)?.code === "BAD_REQUEST") {
        invalidateCertificate(bodyCertificate(key));
        put({ ...cur, status: "error", tooLong: true });
        return;
      }
      const rejectedSource = sources.get(key), rejectedTimer = w.timer;
      const failed: LocalDraft = { ...cur, status: "error" };
      invalidateCertificate(bodyCertificate(key));
      put(failed);
      if (writers.get(key) !== w || w.operation !== operation || get(key) !== failed || sources.get(key) !== rejectedSource || rejectedSource?.failed || w.stopping || w.timer !== rejectedTimer) return;
      const delay = RETRY_MS[Math.min(w.attempts, RETRY_MS.length - 1)]!;
      w.attempts++;
      if (w.timer) clearTimeout(w.timer);
      const timer = setTimeout(() => {
        if (writers.get(key) !== w || w.timer !== timer) return;
        w.timer = null;
        if (sources.get(key)?.failed) return;
        void save(key);
      }, delay);
      w.timer = timer;
    },
  );
  return w.inflight;
}

/** A missing target is terminal; retain the latest editor source without resetting its document. */
export function markDraftMissing(key: string): void {
  const d = materializeOrCurrent(key);
  if (!d || d.recovery) return;
  changeVersion++;
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  if (w) { w.timer = null; w.dirtySince = null; }
  invalidateCertificate(bodyCertificate(key));
  put({ ...d, status: "error", tooLong: false, recovery: { state: "missing" }, attachmentOwner: Boolean(d.attachments?.length) });
}

/** Explicit intent only: an unknown previous copy may already exist, as the action explains. */
export function copyDraft(key: string): Promise<void> {
  const d = get(key);
  if (draftEditsHeld() || !d?.recovery || d.sending || writers.get(key)?.stopping) return Promise.resolve();
  const w = writer(key);
  if (w.inflight) return w.inflight;
  changeVersion++;
  return save(key, true);
}

/** "Retry" after an error: now. */
export function retryDraft(key: string): void {
  if (get(key)?.recovery || writers.get(key)?.stopping) return;
  const w = writer(key);
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  void save(key);
}

/** Cancels the debounce and waits until what is written now is saved (or the save fails). */
export async function flushDraft(key: string): Promise<void> {
  const w = writers.get(key);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  for (let i = 0; i < 5; i++) {
    if (w.inflight) await w.inflight;
    const d = get(key);
    if (!d || d.recovery || d.status === "error" || !authored(d) || d.savedRev === d.localRev) return;
    await save(key);
  }
}

/** Every dirty draft, before the page goes away or hands the mailbox over; gives up after `capMs`. */
export async function flushAllDrafts(capMs = 1000): Promise<void> {
  const all = Promise.all(Object.keys(useDrafts.getState().drafts).map((k) => flushDraft(k).catch(() => {})));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([all, new Promise((r) => { timer = setTimeout(r, capMs); })]); } finally { clearTimeout(timer); }
}

/**
 * Before something that would drop the page (a new build taking over): every
 * draft flushed, and true only if each is saved as written. A save that is
 * slow past `capMs` or failed says false, and the caller doesn't go ahead.
 */
export async function draftsSaved(capMs = 5000): Promise<boolean> {
  const version = draftChangeVersion();
  if (draftWorkPending()) return false;
  await flushAllDrafts(capMs);
  return !draftWorkPending() && draftChangeVersion() === version && Object.values(useDrafts.getState().drafts).every((d) => !authored(d) || (!d.recovery && d.savedRev === d.localRev && d.status !== "error"));
}

/** Waits for the save in flight (if any) and stops further saves: the draft is about to be sent or discarded. */
async function settle(key: string): Promise<LocalDraft | undefined> {
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  if (w) w.timer = null;
  if (w?.inflight) await w.inflight.catch(() => {});
  // after the wait: what was typed while that save was out (and it may have failed) is in what this returns
  return materialize(key);
}

/** The draft as it is now, after any save in flight answered, ready to send. */
export async function draftForSend(key: string): Promise<LocalDraft | undefined> {
  if (draftEditsHeld() || get(key)?.recovery || writers.get(key)?.stopping) return undefined;
  const w = writer(key);
  const needsContextSave = Boolean(get(key)?.replyContext || get(key)?.mode === "forward");
  if (needsContextSave) {
    await flushDraft(key);
    const ready = get(key);
    if (!ready || ready.recovery || ready.status === "error" || (authored(ready) && ready.savedRev !== ready.localRev)) return undefined;
  }
  w.stopping = "send";
  const d = await settle(key);
  return d?.recovery ? undefined : d;
}

/** A send started or settled: while it runs the draft can't be edited or discarded. */
export function markSending(key: string, sending: boolean): void {
  const d = get(key);
  if (d && d.sending !== sending) { changeVersion++; invalidateCertificate(bodyCertificate(key)); put({ ...d, sending }); }
}

/** A send didn't happen (refused or failed): the autosave it paused picks up whatever isn't saved yet. */
export function resumeDraft(key: string, scheduleSave = true): void {
  const w = writers.get(key);
  if (w?.stopping === "send") w.stopping = null;
  const d = get(key);
  if (scheduleSave && d && authored(d) && d.savedRev !== d.localRev) schedule(key);
}

/** After a successful send (the backend deleted the stored draft with it). */
export function forgetDraft(key: string): void {
  const current = get(key);
  if (current) retireHydrationIdentity(current);
  changeVersion++;
  invalidateNoWriterRead(key);
  invalidateCertificate(bodyCertificate(key)); forgetEditorBody(key);
  sources.delete(key);
  const w = writers.get(key);
  if (w?.ackRead) endDraftAckRead(w.ackRead);
  if (w?.timer) clearTimeout(w.timer);
  writers.delete(key);
  drop(key);
}

/** Deletes a draft; returns what it was, for "Undo". */
export async function discardDraft(key: string): Promise<LocalDraft | undefined> {
  // a send in flight decides: sent, it is gone; failed, it stays for another try
  if (draftEditsHeld() || get(key)?.sending || writers.get(key)?.stopping) return undefined;
  const w = writer(key);
  w.stopping = "discard";
  let d: LocalDraft | undefined;
  try { d = await settle(key); } catch (error) {
    w.stopping = null;
    throw error;
  }
  if (!d || d.sending) return undefined;
  forgetDraft(key);
  if (d.id !== null) await call("drafts.delete", { id: d.id, generation: d.generation ?? "" }).catch(() => {});
  return d;
}

/** "Undo" a discard: the same content as a new draft (saved at once). */
export function restoreDiscarded(d: LocalDraft): string {
  const key = createDraft({ ...fieldsOf(d), uiState: "open" });
  editDraft(key, {});
  void flushDraft(key);
  return key;
}

// ───────────────────────────── restore and lookups ─────────────────────────────

/** At startup: every stored draft, as the backend has it. */
export async function loadDrafts(list: () => Promise<Draft[]> = () => client.call("drafts.list", {})): Promise<void> {
  const navigation = presentationNavigation, excluded = new Set<string>();
  pendingHydration.add(excluded);
  try {
    const stored = await list();
    useDrafts.setState((s) => {
      const drafts = { ...s.drafts }, known = new Set(Object.values(s.drafts).map((d) => d.id));
      for (const d of stored) {
        if (known.has(d.id) || excluded.has(identityOf(d))) continue;
        changeVersion++;
        const local = fromServer(d);
        if (drafts[local.key]) local.key = newKey();
        drafts[local.key] = d.showSourceContext && navigation !== presentationNavigation ? { ...local, presentationExpired: true } : local;
        known.add(d.id);
      }
      return { drafts };
    });
  } finally { pendingHydration.delete(excluded); }
}

interface DraftIndex {
  expiredBySource: Map<number, LocalDraft[]>;
  expiredByThread: Map<number, LocalDraft[]>;
  /** each conversation's most recently edited draft */
  newest: Map<number, LocalDraft>;
  /** conversations with a draft that has something written in it */
  written: Set<number>;
}
/** Durable context and session editor placement have independent lifetimes. */
export const draftPresentationThread = (d: LocalDraft): number | null => d.presentationExpired ? null : d.presentationThreadId ?? (d.sourceContextThreadId !== undefined ? d.sourceContextThreadId : d.mode === "new" ? null : d.threadId);

/** Leaving Reader retires cached placement, not the durable source intent or authored fields. */
export function expireDraftPresentation(threadId: number): void {
  presentationNavigation++;
  useDrafts.setState((s) => {
    let drafts = s.drafts;
    for (const d of Object.values(s.drafts)) {
      if (draftPresentationThread(d) !== threadId || (!d.showSourceContext && d.presentationThreadId === undefined)) continue;
      if (drafts === s.drafts) drafts = { ...drafts };
      invalidateCertificate(bodyCertificate(d.key));
      drafts[d.key] = { ...d, departedThreadId: threadId, presentationThreadId: undefined, sourceContextThreadId: d.sourceContextThreadId ?? threadId, presentationExpired: true, presentationEpoch: (d.presentationEpoch ?? 0) + 1 };
    }
    return drafts === s.drafts ? s : { drafts };
  });
}

/** Retire one display association without changing its durable fields or editor revision. */
export function invalidateDraftPresentation(key: string): void {
  const d = get(key);
  if (d) { const next = { ...d, departedThreadId: d.departedThreadId ?? draftPresentationThread(d) ?? undefined, presentationThreadId: undefined, presentationExpired: true, presentationEpoch: (d.presentationEpoch ?? 0) + 1 }; advanceBodyAuthority(d, next); put(next); }
}

/** Explicit strip open has just validated this source; no authored edit or save is needed. */
export function validateDraftPresentation(key: string, threadId: number): void {
  const d = get(key);
  if (d) { const next = { ...d, presentationThreadId: undefined, sourceContextThreadId: threadId, presentationExpired: false, presentationEpoch: (d.presentationEpoch ?? 0) + 1 }; advanceBodyAuthority(d, next); put(next); }
}

/** One pass per drafts update (the map is replaced on every change), shared by every row, the reader and the strip. */
const indexes = new WeakMap<Record<string, LocalDraft>, DraftIndex>();
export function draftIndex(drafts: Record<string, LocalDraft>): DraftIndex {
  let index = indexes.get(drafts);
  if (index) return index;
  index = { newest: new Map(), written: new Set(), expiredBySource: new Map(), expiredByThread: new Map() };
  for (const d of Object.values(drafts)) {
    const add = (map: Map<number, LocalDraft[]>, id: number) => { const rows = map.get(id); if (rows) rows.push(d); else map.set(id, [d]); };
    const hints = new Set<number>();
    if (d.presentationExpired && authored(d) && d.departedThreadId != null) hints.add(d.departedThreadId);
    if (d.presentationExpired && d.showSourceContext && d.mode !== "new") {
      const source = d.mode === "forward" ? d.forwardOfMessageId : d.inReplyToMessageId;
      if (source !== null) {
        add(index.expiredBySource, source);
        if (d.sourceContextThreadId != null) hints.add(d.sourceContextThreadId);
      }
    }
    for (const hint of hints) add(index.expiredByThread, hint);
    const threadId = draftPresentationThread(d);
    if (threadId === null) continue;
    const best = index.newest.get(threadId);
    if (!best || d.updatedAt > best.updatedAt) index.newest.set(threadId, d);
    if (authored(d) && (d.bodyText.trim() || d.id !== null || sources.get(d.key)?.dirty)) index.written.add(threadId);
  }
  indexes.set(drafts, index);
  return index;
}

/** The draft shown inline in a conversation: the most recently edited one there. */
export function threadDraftKey(drafts: Record<string, LocalDraft>, threadId: number): string | null {
  return draftIndex(drafts).newest.get(threadId)?.key ?? null;
}

/** The draft a conversation shows inline: the one opened explicitly for it, else its most recent. */
export function shownDraftKey(drafts: Record<string, LocalDraft>, threadId: number, shown: { threadId: number; key: string } | null): string | null {
  if (shown && shown.threadId === threadId && drafts[shown.key] && draftPresentationThread(drafts[shown.key]!) === threadId) return shown.key;
  return threadDraftKey(drafts, threadId);
}

/** For list rows: does this conversation have a draft with something written in it? (one boolean per row) */
export function useHasDraft(threadId: number): boolean {
  return useDrafts((s) => draftIndex(s.drafts).written.has(threadId));
}

export function toAddressList(text: string): Address[] {
  return parseAddressList(text);
}

// test builds: a send held in flight, to check that nothing edits under it
exposeForTests({ holdSending: (sending: boolean) => Object.keys(useDrafts.getState().drafts).forEach((k) => markSending(k, sending)) });
