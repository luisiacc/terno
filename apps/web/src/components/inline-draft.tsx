import { AttachButton, DraftAttachments } from "./attachments";
import { useComposerDrop } from "./composer-drop";
import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { IconButton } from "@terno/ui/components/icon-button";
import { cn } from "@terno/ui/lib/utils";
import { ChevronDown, Forward, PenLine, Pin, PinOff, ReplyAll, Trash2 } from "@terno/ui/icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { collapseInlineDraft, composeFocusPending, finishComposeFocus, openCompose, reopenInlineDraft, sendDraft, useDraftsReturning } from "~/lib/compose";
import { copyDraft, discardDraft, draftEditsHeld, draftSenderLocked, editDraft, editDraftRecipients, nothingWrittenIn, restoreDiscarded, retryDraft, signatureBlock, useDrafts, type BodyCheckpoint, type DraftFields, type LocalDraft } from "~/lib/drafts";
import { SenderAvatar } from "./sender-avatar";
import { RecipientInput, recipientSummary } from "./recipient-input";
import { warmAutocomplete } from "~/lib/autocomplete";
import { richT } from "~/lib/i18n";
import { keepInView } from "~/lib/reader-scroll";
import { clearSendProblem, useSendProblem } from "~/lib/send-problem";
import { registerUndo, snack } from "~/lib/snack";
import { getSelectionWriteRevision, setApp, useApp } from "~/state/app";
import { Expand } from "./expand";
import { isSendLaterKey, openSendLater, SendButton } from "./send-button";
import { controllerFor, popupOpen } from "./composer/controller";
import { DraftCommandsHost } from "~/lib/draft-commands";
import { ComposerFormatBar, FormatToggle, LinkButton } from "./composer/controls";
import { RichBody } from "./composer/rich";
import { focusPinned, usePinned } from "~/lib/pinned-draft-state";
import { pinDraft, unpinDraft } from "~/lib/pinned-draft";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { AiDraftButton, AiRowSlot } from "./composer/ai-slot";
import { aiDraftHooks, useAiDraftUi } from "~/lib/ai-draft-state";

export { focusSoon } from "~/lib/compose-focus-move";
import { focusSelector, focusSoon, focusMoveGeneration, type InlineFocusMove } from "~/lib/compose-focus-move";

/** A borderless field row: a real label, the control, hairline below. */
function Row({ label, htmlFor, children, hidden, note }: { label: string; htmlFor?: string; children: React.ReactNode; hidden?: boolean; note?: React.ReactNode }) {
  if (hidden) return null;
  return (
    <div className="hairline-b group/row">
      <div className="flex min-h-[38px] items-center gap-2.5 px-3.5" data-recipient-row>
        {/* on the first line when the chips wrap */}
        <label htmlFor={htmlFor} className="w-14 shrink-0 self-start text-xs leading-[38px] text-muted-foreground group-focus-within/row:text-foreground">
          {label}
        </label>
        {children}
      </div>
      {note}
    </div>
  );
}

/** Send's message about a field, under it on the values' line (px-3.5 + the label's w-14 + the gap); it goes with the form. */
function FieldProblem({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" data-testid="compose-field-problem" className="-mt-1.5 pr-3.5 pb-2 pl-20 text-xs text-destructive-ink">
      {message}
    </p>
  );
}

/** The tinted card a draft is written in: a conversation's, and a new message's (plan 130). */
export const DRAFT_SURFACE = "rounded-xl bg-(--draft-bg) [box-shadow:0_0_0_var(--hairline-w)_var(--draft-ring),var(--draft-shadow)]";

const input = "h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground";

/** The draft's fields, shared by the inline reply and the new message in the reader. */
/** `threadAccountId`: a reply's conversation's account: From stays out of the way while the reply goes from it (plan 158) */
export function DraftFieldsForm({ d, accounts, showSubject, threadAccountId }: { d: LocalDraft; accounts: Account[]; showSubject: boolean; threadAccountId?: number }) {
  const id = useId();
  const cancelReveal = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelReveal.current?.(), []);
  // Send's message goes with the form it was about
  useEffect(() => () => clearSendProblem(d.key), [d.key]);
  const problem = useSendProblem((s) => (s.problem?.key === d.key ? s.problem : null));
  const problemNote = (field: "to" | "cc" | "bcc") => problem?.field === field ? <FieldProblem id={`${id}-problem`} message={problem.message} /> : undefined;
  const problemId = (field: "to" | "cc" | "bcc") => problem?.field === field ? `${id}-problem` : undefined;
  // a row shows when it was disclosed, when it has something in it, or when the mode needs it (a forward's
  // subject): a conversion that fills Cc in while the draft is open shows it, never sends to a hidden field
  const [ccOpen, setCc] = useState(false);
  const [bccOpen, setBcc] = useState(false);
  const [subjectOpen, setSubject] = useState(false);
  const [fromOpen, setFromOpen] = useState(false);
  const cc = ccOpen || d.ccText !== "";
  const bcc = bccOpen || d.bccText !== "";
  const subject = subjectOpen || showSubject || d.subjectEdited;
  const update = (patch: Partial<DraftFields>) => editDraft(d.key, patch);
  /** a recipient field's change: the addresses the user put in are theirs now, no longer Terno's (Codex review 9) */
  const canEditRecipients = () => {
    const current = useDrafts.getState().drafts[d.key];
    return !!current && current.id === d.id && current.generation === d.generation && !current.sending && !draftEditsHeld();
  };
  const recipients = (field: "to" | "cc" | "bcc", text: string, authored: readonly string[]): boolean => {
    if (!canEditRecipients()) return false;
    clearSendProblem(d.key);
    const before = useDrafts.getState().drafts[d.key]!;
    const expectedAuto = authored.length ? before.auto[field].filter((email) => !authored.includes(email.toLowerCase())) : before.auto[field];
    const sameOwner = (current: LocalDraft | undefined) => !!current && current.key === before.key && current.id === before.id && current.generation === before.generation && current.accountId === before.accountId && current.mode === before.mode && current.threadId === before.threadId && current.inReplyToMessageId === before.inReplyToMessageId && current.forwardOfMessageId === before.forwardOfMessageId && current.uiState === before.uiState && current.recovery === before.recovery;
    const matches = (current: LocalDraft, value: string, auto: readonly string[]) => current[`${field}Text`] === value && current.auto[field].length === auto.length && current.auto[field].every((entry, i) => entry === auto[i]);
    let changed = false, transitions = 0;
    const stop = useDrafts.subscribe((state, previous) => {
      const a = previous.drafts[d.key], b = state.drafts[d.key];
      if (!sameOwner(a) || !sameOwner(b)) { changed = true; return; }
      if (!matches(a!, b![`${field}Text`], b!.auto[field])) {
        transitions++;
        if (transitions !== 1 || !matches(a!, before[`${field}Text`], before.auto[field]) || !matches(b!, text, expectedAuto)) changed = true;
      }
    });
    try {
      const accepted = editDraftRecipients(d.key, field, text, authored);
      const current = useDrafts.getState().drafts[d.key];
      return accepted && !changed && sameOwner(current) && matches(current!, text, expectedAuto);
    } finally { stop(); }
  };
  const toggle = (open: boolean, set: (v: boolean) => void, label: string, field: string, testId: string) =>
    !open && (
      <button
        type="button"
        aria-expanded="false"
        aria-controls={`${id}-${field}`}
        data-testid={testId}
        onClick={(event) => {
          cancelReveal.current?.();
          const root = event.currentTarget.closest<HTMLElement>("[data-draft-key]");
          if (!root || !canEditRecipients()) return;
          const generation = focusMoveGeneration();
          let raf = 0;
          const cancel = () => {
            cancelAnimationFrame(raf);
            document.removeEventListener("focusin", cancel, true);
            document.removeEventListener("pointerdown", cancel, true);
            document.removeEventListener("keydown", key, true);
            offDrafts();
            if (cancelReveal.current === cancel) cancelReveal.current = null;
          };
          const key = (event: KeyboardEvent) => { if (event.key === "Tab") cancel(); };
          const offDrafts = useDrafts.subscribe((state, previous) => {
            if (state.held || previous.held || !canEditRecipients()) cancel();
          });
          cancelReveal.current = cancel;
          document.addEventListener("focusin", cancel, true);
          document.addEventListener("pointerdown", cancel, true);
          document.addEventListener("keydown", key, true);
          set(true);
          raf = requestAnimationFrame(() => {
            cancel();
            if (!root.isConnected || root.closest("[inert]") || generation !== focusMoveGeneration() || !canEditRecipients()) return;
            root.querySelector<HTMLElement>(`[data-testid="compose-${field}"]`)?.focus();
          });
        }}
        // quiet at rest: they come up with the row (hovered, or being written in), and always under Tab
        className="h-[22px] rounded-sm px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-fast group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-reveal:opacity-100"
      >
        {label}
      </button>
    );
  const severalFrom = accounts.length > 1 || !accounts.some((a) => a.id === d.accountId);
  const fromRow = severalFrom && (fromOpen || threadAccountId === undefined || d.accountId !== threadAccountId);
  return (
    <div data-draft-key={d.key}>
      {fromRow && (
        <Row label={t("compose.from")}>
          <Select disabled={d.sending || draftSenderLocked(d)} value={String(d.accountId)} onValueChange={(v) => update({ accountId: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: `${a.displayName} · ${a.email}` }))}>
            <SelectTrigger id={`${id}-from`} size="sm" aria-label={t("compose.from")} className="-ml-2.5 h-7 min-w-0 border-0 bg-transparent shadow-none dark:bg-transparent dark:hover:bg-muted" data-testid="compose-from" title={draftSenderLocked(d) ? t("attachments.senderLocked") : undefined}>
              {/* a long address truncates in a narrow pane: the corner's Pin stays in the row */}
              <SelectValue className="block! min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.displayName} · {a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      <Row label={t("compose.to")} htmlFor={`${id}-to`} note={problemNote("to")}>
        <RecipientInput id={`${id}-to`} testId="compose-to" label={t("compose.to")} readOnly={d.sending} canEdit={canEditRecipients} className={input} value={d.toText} onChange={(v, a) => recipients("to", v, a)} placeholder={t("compose.toPlaceholder")} accountId={d.accountId} others={[d.ccText, d.bccText]} describedBy={problemId("to")} />
        <span className="mt-2 flex shrink-0 gap-0.5 self-start">
          {toggle(cc, setCc, t("compose.cc"), "cc", "compose-show-cc")}
          {toggle(bcc, setBcc, t("compose.bcc"), "bcc", "compose-show-bcc")}
          {toggle(subject, setSubject, t("compose.subject"), "subject", "compose-show-subject")}
          {severalFrom && toggle(fromRow, setFromOpen, t("compose.from"), "from", "compose-show-from")}
        </span>
      </Row>
      <Row label={t("compose.cc")} htmlFor={`${id}-cc`} hidden={!cc} note={problemNote("cc")}>
        <RecipientInput id={`${id}-cc`} testId="compose-cc" label={t("compose.cc")} readOnly={d.sending} canEdit={canEditRecipients} className={input} value={d.ccText} onChange={(v, a) => (setCc(true), recipients("cc", v, a))} accountId={d.accountId} others={[d.toText, d.bccText]} describedBy={problemId("cc")} />
      </Row>
      <Row label={t("compose.bcc")} htmlFor={`${id}-bcc`} hidden={!bcc} note={problemNote("bcc")}>
        <RecipientInput id={`${id}-bcc`} testId="compose-bcc" label={t("compose.bcc")} readOnly={d.sending} canEdit={canEditRecipients} className={input} value={d.bccText} onChange={(v, a) => (setBcc(true), recipients("bcc", v, a))} accountId={d.accountId} others={[d.toText, d.ccText]} describedBy={problemId("bcc")} />
      </Row>
      <Row label={t("compose.subject")} htmlFor={`${id}-subject`} hidden={!subject}>
        <input id={`${id}-subject`} data-testid="compose-subject" className={input} value={d.subject} onChange={(e) => update({ subject: e.target.value, subjectEdited: true })} />
      </Row>
      <AiRowSlot draftKey={d.key} />
    </div>
  );
}

/** What the draft's save state says, for screen readers too: "saved" only for an acknowledged revision. */
export function SaveState({ d }: { d: LocalDraft }) {
  const held = useDrafts((s) => s.held);
  const action = useRef<HTMLButtonElement | null>(null);
  const actionRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node && action.current === document.activeElement) {
      controllerFor(d.key)?.focus("keep");
    }
    action.current = node;
  }, [d.key]);
  const recovery = d.recovery;
  const message = recovery?.state === "refused" ? recovery.reason ?? "invalid" : recovery?.state;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground" data-testid="draft-status">
      <span aria-live="polite" aria-atomic="true">
        {held ? t("compose.status.restart") : message ? t(`compose.recovery.${message}`) : d.status === "saved" ? t("compose.status.saved") : null}
        {recovery?.state === "unknown" && recovery.reason && ` ${t(`compose.recovery.${recovery.reason}`)}`}
      </span>
      {recovery && (
        <Button
          ref={actionRef}
          variant="link-secondary"
          data-testid="draft-save-copy"
          className="text-xs"
          aria-busy={recovery.state === "copying"}
          aria-disabled={recovery.state === "copying"}
          onClick={() => { if (recovery.state !== "copying") void copyDraft(d.key); }}
        >
          {t(recovery.state === "unknown" ? "compose.recovery.another" : "compose.recovery.copy")}
        </Button>
      )}
      {!recovery && d.status === "error" &&
        richT(d.tooLong ? "compose.status.tooLong" : "compose.status.failed", {
          retry: (text) => (
            <Button variant="link-secondary" className="text-xs" onClick={() => retryDraft(d.key)}>
              {text}
            </Button>
          ),
        })}
    </span>
  );
}

/** The From account's signature, as it will be sent below the text (edited in Settings → Accounts). */
export function SignaturePreview({ accountId, className }: { accountId: number; className?: string }) {
  const signature = useApp((s) => s.accounts.find((a) => a.id === accountId)?.signature ?? "");
  if (!signature.trim()) return null;
  return (
    <div className={cn("text-sm whitespace-pre-wrap text-muted-foreground", className)} data-testid="compose-signature" aria-label={t("compose.signature")}>
      {signatureBlock(signature)}
    </div>
  );
}

/** The quoted original: kept apart from the text, shown on demand, removable. */
export function Quote({ d }: { d: LocalDraft }) {
  const [show, setShow] = useState(false);
  const id = useId();
  if (!d.quotedText) return null;
  if (!d.includeQuote) {
    return (
      <div className="px-3.5 pb-1 text-xs text-muted-foreground">
        {richT("compose.quote.removed", {
          include: (text) => (
            <Button variant="link-secondary" className="text-xs" onClick={() => editDraft(d.key, { includeQuote: true })}>
              {text}
            </Button>
          ),
        })}
      </div>
    );
  }
  return (
    <div className="px-3.5 pb-1">
      <button
        type="button"
        aria-expanded={show}
        aria-controls={id}
        aria-label={show ? t("compose.quote.hide") : t("compose.quote.show")}
        data-testid="compose-quote"
        onClick={() => setShow((v) => !v)}
        className="h-4 rounded-sm bg-muted px-1.5 text-[10px] leading-4 tracking-[0.15em] text-muted-foreground hover:text-foreground"
      >
        •••
      </button>
      <div id={id}>
        {show && (
          <div className="mt-2 border-l-2 border-hairline pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {d.quotedText}
            <Button variant="link-secondary" className="mt-2 flex text-xs" onClick={() => editDraft(d.key, { includeQuote: false })} data-testid="compose-quote-remove">
              {t("compose.quote.remove")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The collapsed draft's words: all of them on the one line (the greeting alone says nothing). */
const draftPreview = (text: string): string => text.slice(0, 300).replace(/\s+/g, " ").trim();

/** How much of an opening composer has to show: down to its first lines of text, with room for its foot. */
function composerWanted(el: HTMLElement): number {
  const body = el.querySelector<HTMLElement>("[data-testid=compose-body]");
  if (!body) return Infinity;
  const foot = el.querySelector<HTMLElement>("[data-draft-foot]")?.offsetHeight ?? 0;
  return body.getBoundingClientRect().top - el.getBoundingClientRect().top + 72 + foot;
}

/** The inline draft's accessible name: "Reply to Ana", "Forward" (nobody yet). Reply-all reads as a reply. */
function formLabel(forward: boolean, who: string): string {
  if (forward) return who ? t("compose.form.forward", { name: who }) : t("compose.form.forwardEmpty");
  return who ? t("compose.form.reply", { name: who }) : t("compose.form.replyEmpty");
}

/**
 * What follows the last message of a conversation: the reply bar, or the
 * conversation's draft (open, or collapsed into one line). The three share
 * one tinted surface; switching between them animates its rows. Opening
 * keeps the draft in view; focus moves only on an explicit open or exit.
 */
/** `icons`: the account's own picture may be asked for (plan 22; never in spam) */
/** `replyAll`: offered in the bar only when it reaches someone Reply doesn't */
export function DraftSlot({ threadId, draftKey, replyTo, replyAll = true, account, icons = true, checkpoint, onCheckpointReopen }: { threadId: number; draftKey: string | null; replyTo: string; replyAll?: boolean; account: Account | undefined; icons?: boolean; checkpoint?: BodyCheckpoint; onCheckpointReopen?: () => () => void }) {
  // plan 115: this conversation's draft is in the pinned card (kept so even after the conversation's placement expired)
  const pinned = usePinned((s) => s.key !== null && (s.key === draftKey || (draftKey === null && s.threadId === threadId)));
  const d = useDrafts((s) => (draftKey && !pinned ? s.drafts[draftKey] : undefined));
  const accounts = useApp((s) => s.accounts);
  const recovering = useDraftRecovery((s) => s.open);
  const focus = useApp((s) => (draftKey && !pinned && s.draftFocus?.key === draftKey ? s.draftFocus : null));
  const rootRef = useRef<HTMLDivElement>(null);
  const slotMove = useRef<InlineFocusMove | null>(null), slotGeneration = useRef(0);
  useEffect(() => {
    const generation = ++slotGeneration.current;
    return () => { const move = slotMove.current; queueMicrotask(() => { if (slotGeneration.current === generation) move?.cancel(); }); };
  }, []);
  const exitWatches = useRef(new Set<() => void>());
  useEffect(() => () => { for (const stop of exitWatches.current) stop(); }, []);
  const formatId = useId();
  // a written draft on its way back to this conversation: nothing for the moment its source takes to check (plan 158)
  const returning = useDraftsReturning((s) => s.threadId === threadId) && !d && !pinned && !recovering;
  const state: "bar" | "open" | "collapsed" | "pinned" | "returning" = pinned ? "pinned" : returning ? "returning" : !d ? "bar" : d.uiState;

  // a conversation is open: its reply may come next, so the editor starts loading (once)
  // and ⌘J may too, on someone who has AI set up: the row answers in the frame of the key
  // a draft is open: suggestions get ready (once per session)
  useEffect(() => {
    if (state === "open") warmAutocomplete();
  }, [state]);

  // an explicit open (r/a/f, the bar, the menu) asks for focus: honor it once
  useEffect(() => {
    if (!focus || !d || useApp.getState().draftFocus !== focus) return;
    const eligible = composeFocusPending(threadId, focus.key, focus.seq);
    if (focus.leased && !eligible) {
      finishComposeFocus(focus.key, focus.seq, false);
      if (useApp.getState().draftFocus === focus) setApp({ draftFocus: null });
      return;
    }
    const selector = focusSelector(focus.target);
    if (focus.move && !focus.move.bind(rootRef.current, selector)) {
      if (useApp.getState().draftFocus === focus) setApp({ draftFocus: null });
      return;
    }
    if (focus.move) slotMove.current = focus.move;
    else focusSoon(selector, rootRef.current, 12, focus.leased ? (fallback) => finishComposeFocus(focus.key, focus.seq, fallback) : undefined, focus.leased ? () => composeFocusPending(threadId, focus.key, focus.seq) : undefined);
    if (useApp.getState().draftFocus === focus) setApp({ draftFocus: null });
  }, [focus?.seq]);

  const aiBadge = useAiDraftUi((s) => (d ? s.rows[d.key] : undefined));
  const collapse = () => {
    if (!d) return;
    // put away with nothing in it, it isn't a draft: it goes, and the reply bar is back (plan 158)
    if (!aiBadge && nothingWrittenIn(d.key)) { void discard(true); return; }
    const valid = collapseInlineDraft(d.key);
    if (!valid || !valid()) return;
    focusSoon("[data-testid=draft-collapsed]", rootRef.current, 12, () => true, valid, (cancel) => {
      const app = useApp.subscribe(() => { if (!valid()) cancel(); });
      const drafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held) cancel(); });
      return () => { app(); drafts(); };
    });
  };
  const reopen = () => {
    if (!d) return;
    reopenInlineDraft(threadId, d.key, checkpoint, onCheckpointReopen);
  };
  const exitFocus = () => {
    const root = rootRef.current, initial = useApp.getState(), active = document.activeElement;
    const revision = getSelectionWriteRevision();
    let changed = !root || draftEditsHeld(), stopped = false, expectedRequest = focusMoveGeneration(), cancel: (() => void) | undefined;
    const invalidate = () => { changed = true; cancel?.(); };
    const moved = (event: FocusEvent) => { if (event.target !== active) invalidate(); };
    const offApp = useApp.subscribe((state, previous) => {
      if (state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.compose !== previous.compose || state.checked !== previous.checked || state.scope !== previous.scope || state.accountId !== previous.accountId || state.dialog !== previous.dialog || state.fatal !== previous.fatal || state.view !== previous.view || state.categoryId !== previous.categoryId || state.reviewCategoryId !== previous.reviewCategoryId || state.query !== previous.query || state.listFilters !== previous.listFilters || state.draftFocus !== previous.draftFocus || state.draftShown !== previous.draftShown) invalidate();
    });
    const offDrafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held) invalidate(); });
    document.addEventListener("focusin", moved, true);
    const stop = () => { if (stopped) return; stopped = true; offApp(); offDrafts(); document.removeEventListener("focusin", moved, true); exitWatches.current.delete(stop); };
    exitWatches.current.add(stop);
    const valid = () => !stopped && !changed && rootRef.current === root && !!root?.isConnected && getSelectionWriteRevision() === revision && focusMoveGeneration() === expectedRequest && useApp.getState().selectedId === initial.selectedId && !draftEditsHeld();
    return { root, valid, stop, prepare: () => { expectedRequest = focusMoveGeneration() + 1; }, watch: (onCancel: () => void) => { cancel = onCancel; return stop; } };
  };
  const send = async (sendAt?: number) => {
    if (!d) return;
    const request = exitFocus();
    let transferred = false;
    try {
      const ok = await sendDraft(d.key, sendAt);
      if (ok && request.valid()) { request.prepare(); focusSoon("[data-testid=quick-reply]", request.root, 12, () => true, request.valid, request.watch); transferred = true; }
    } finally { if (!transferred) request.stop(); }
  };
  const discard = async (empty = false) => {
    if (!d) return;
    const request = exitFocus();
    let transferred = false;
    try {
      const gone = await discardDraft(d.key);
      if (!gone) return;
      if (!empty) {
        const undo = registerUndo(() => restoreDiscarded(gone));
        snack(t("compose.discarded"), { action: { label: t("common.undo"), name: t("compose.undoDiscard"), undo } });
      }
      if (request.valid()) { request.prepare(); focusSoon("[data-testid=quick-reply]", request.root, 12, () => true, request.valid, request.watch); transferred = true; }
    } finally { if (!transferred) request.stop(); }
  };

  const me = account?.displayName || account?.email || "";
  const who = d ? d.toText.split(",")[0]?.replace(/<.*$/, "").replace(/"/g, "").trim() || d.toText : "";
  const label = !d ? "" : d.mode === "new" ? t("compose.newMessage") : formLabel(d.mode === "forward", who);
  const drop = useComposerDrop(d?.key ?? "", d?.sending ?? false);

  return (
    <div ref={rootRef} className={cn("mt-5", DRAFT_SURFACE, state === "returning" && "min-h-10")} data-testid="draft-slot" data-state={state} data-thread={threadId}>
      <Expand open={state === "bar"}>
        <div className="flex h-10 items-center gap-0.5 pr-1.5 pl-2.5" data-testid="reply-bar">
          <button type="button" onClick={() => void openCompose("reply", threadId)} title={me ? t("compose.bar.from", { name: me }) : undefined} data-testid="quick-reply" className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left text-sm text-muted-foreground">
            <SenderAvatar name={me} email={account?.email ?? me} icon={icons} className="size-[22px] text-[9.5px]" />
            <span className="truncate">{t("compose.bar.reply", { name: replyTo })}</span>
          </button>
          {replyAll && (
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("replyAll", threadId)} data-testid="quick-reply-all">
              <ReplyAll /> {t("compose.bar.replyAll")}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("forward", threadId)} data-testid="quick-forward">
            <Forward /> {t("compose.bar.forward")}
          </Button>
          <AiDraftButton threadId={threadId} testId="quick-ai" />
        </div>
      </Expand>
      <Expand open={state === "pinned"}>
        <div className="flex h-10 items-center gap-0.5 pr-1.5 pl-1" data-testid="draft-pinned">
          <button type="button" onClick={focusPinned} data-testid="draft-pinned-go" className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 text-left text-sm">
            <Pin className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">{t("compose.pinned")}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{t("compose.pinnedHint")}</span>
          </button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => unpinDraft()} data-testid="draft-pinned-unpin">
            <PinOff /> {t("compose.unpin")}
          </Button>
        </div>
      </Expand>
      <Expand open={state === "collapsed"}>
        {d && (
          <button type="button" onClick={reopen} data-testid="draft-collapsed" aria-expanded="false" className="flex h-10 w-full items-center gap-2 rounded-xl pr-3 pl-3 text-left text-sm">
            <PenLine className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">{t("compose.draft")}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t(d.mode === "forward" ? "compose.collapsed.forward" : "compose.collapsed.to", { to: recipientSummary(d.toText) || "—", preview: aiBadge === "writing" ? t("aiDraft.writing") : aiBadge === "ready" ? t("aiDraft.choice.ready") : draftPreview(d.bodyText) })}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </Expand>
      {/* a composer's foot sticks to the reader's, so its fields and first lines are what has to come into view: the subject stays when it can */}
      <Expand open={state === "open"} onOpening={(el) => keepInView(el, undefined, undefined, () => composerWanted(el))}>
        {d && (
          <form
            aria-label={label}
            data-testid="composer"
            data-draft-key={d.key}
            data-mode={d.mode}
            className="relative rounded-xl"
            {...drop.handlers}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            onKeyDown={(e) => {
              // keys from a popover or menu (portaled: React still bubbles them here) aren't the composer's; the editor
              // itself prevents every Enter and Esc (ProseMirror's own), so defaultPrevented can't tell
              if (!e.currentTarget.contains(e.target as Node) || e.nativeEvent.isComposing) return;
              if (isSendLaterKey(e)) {
                e.preventDefault();
                openSendLater(d.key);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && !popupOpen()) {
                e.preventDefault();
                e.stopPropagation();
                // the AI row's first: it stops a stream, closes itself (§10.4)
                if (!aiDraftHooks.escape(d.key)) collapse();
              }
            }}
          >
            <DraftFieldsForm
              d={d}
              accounts={accounts}
              showSubject={d.mode === "forward" || d.mode === "new"}
              threadAccountId={account?.id}
            />
            <RichBody draftKey={d.key} checkpoint={checkpoint} placeholder={d.mode === "new" ? t("compose.bodyPlaceholder.new") : d.mode === "forward" ? t("compose.bodyPlaceholder.forward") : t("compose.bodyPlaceholder.reply")} className="block min-h-[132px] w-full px-3.5 pt-3 pb-1 text-base" />
            <DraftAttachments d={d} />
            <SignaturePreview accountId={d.accountId} className="px-3.5 pb-2" />
            <Quote d={d} />
            {/* Send stays on screen however long the draft or the conversation is (plan 158); what's written fades under it */}
            <div data-draft-foot className="sticky bottom-[var(--reader-dock,0px)] z-[1] rounded-b-xl bg-(--draft-bg) before:pointer-events-none before:absolute before:inset-x-0 before:-top-3 before:h-3 before:bg-linear-to-t before:from-(--draft-bg) before:to-transparent">
            <ComposerFormatBar draftKey={d.key} id={formatId} className="px-2 pt-1.5" />
            <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2 pb-2.5">
              <SendButton d={d} onSend={(at) => void send(at)} className="mr-1.5" />
              <FormatToggle controls={formatId} />
              <AttachButton d={d} />
              <LinkButton draftKey={d.key} disabled={d.sending} />
              <AiDraftButton draftKey={d.key} disabled={d.sending} testId="compose-ai" />
              <span className="ml-1.5 min-w-0">
                <SaveState d={d} />
              </span>
              <span className="ml-auto flex gap-0.5">
                {/* plan 115: not from Review drafts, which owns the draft while it's open */}
                {!recovering && (
                  <IconButton label={t("compose.pin")} onClick={() => pinDraft(d.key)} data-testid="compose-pin" disabled={d.sending}>
                    <Pin />
                  </IconButton>
                )}
                <IconButton label={t("compose.discard")} onClick={() => void discard()} data-testid="compose-discard" disabled={d.sending}>
                  <Trash2 />
                </IconButton>
                <IconButton label={t("compose.collapse")} shortcut="escape" onClick={collapse} data-testid="compose-collapse">
                  <ChevronDown />
                </IconButton>
              </span>
            </div>
            </div>
            {state === "open" && drop.layer}
            {state === "open" && <DraftCommandsHost draftKey={d.key} root={rootRef} send={(at) => void send(at)} discard={() => void discard()} close={collapse} sending={d.sending} />}
          </form>
        )}
      </Expand>
    </div>
  );
}
