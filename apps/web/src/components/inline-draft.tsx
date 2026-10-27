import { AttachButton, DraftAttachments } from "./attachments";
import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { ChevronDown, Forward, PenLine, ReplyAll, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { openCompose, sendDraft, supersedeCompose } from "~/lib/compose";
import { copyDraft, discardDraft, draftSenderLocked, editDraft, flushDraft, restoreDiscarded, retryDraft, setDraftUi, signatureBlock, useDrafts, type BodyCheckpoint, type DraftFields, type LocalDraft } from "~/lib/drafts";
import { SenderAvatar } from "./sender-avatar";
import { RecipientInput, recipientSummary } from "./recipient-input";
import { warmAutocomplete } from "~/lib/autocomplete";
import { richT } from "~/lib/i18n";
import { keepInView } from "~/lib/reader-scroll";
import { registerUndo, snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { Expand } from "./expand";
import { controllerFor, popupOpen } from "./composer/controller";
import { ComposerBody, ComposerFormatBar, FormatToggle, LinkButton, preloadComposer } from "./composer/lazy";

/** The focus move waiting for its element (one at a time: a newer request replaces it). */
let pendingFocus: { find: () => HTMLElement | null; done: () => void } | null = null;

const target = (selector: string, root: HTMLElement | null) =>
  // while the editor's chunk loads, its stand-in takes the keys (and hands them over)
  (root ?? document).querySelector<HTMLElement>(selector) ?? (selector.includes("compose-body") ? (root ?? document).querySelector<HTMLElement>("[data-testid=compose-body-loading]") : null);
const focusable = (el: HTMLElement | null): el is HTMLElement => el !== null && el.isConnected && !el.closest("[inert]");

function place(el: HTMLElement) {
  el.focus({ preventScroll: true });
  if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
}

/**
 * A key pressed while a focus move is still waiting for its frame (r, then Esc
 * at once) belongs where focus is going, not to the page: focus moves now, a
 * character follows it (the browser types into what is focused after keydown),
 * and any other key is replayed there (Esc collapses that draft). Before this,
 * "r, Esc, r" typed fast lost the Esc and typed the second "r" into the text.
 */
function keyDuringMove(e: KeyboardEvent) {
  const p = pendingFocus;
  if (!p || !e.isTrusted) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const el = p.find();
  if (!focusable(el)) return;
  p.done();
  place(el);
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, bubbles: true, cancelable: true }));
}

/**
 * Puts focus on an element of the draft area once it is rendered and no longer
 * inert (an opening part is inert for a frame).
 */
export function focusSoon(selector: string, root: HTMLElement | null, frames = 12) {
  pendingFocus?.done();
  let raf = 0;
  const done = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", keyDuringMove, true);
    if (pendingFocus === mine) pendingFocus = null;
  };
  const mine = { find: () => target(selector, root), done };
  pendingFocus = mine;
  document.addEventListener("keydown", keyDuringMove, true);
  const tick = (left: number) => {
    raf = requestAnimationFrame(() => {
      const el = target(selector, root);
      if (!focusable(el) && left > 0) return tick(left - 1);
      done();
      if (el) place(el);
    });
  };
  tick(frames);
}

/** A borderless field row: a real label, the control, hairline below. */
function Row({ label, htmlFor, children, hidden }: { label: string; htmlFor?: string; children: React.ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <div className="hairline-b group/row flex min-h-[38px] items-center gap-2.5 px-3.5" data-recipient-row>
      {/* on the first line when the chips wrap */}
      <label htmlFor={htmlFor} className="w-14 shrink-0 self-start text-xs leading-[38px] text-muted-foreground group-focus-within/row:text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

const input = "h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground";

/** The draft's fields, shared by the inline reply and the new message in the reader. */
export function DraftFieldsForm({ d, accounts, showSubject, flat }: { d: LocalDraft; accounts: Account[]; showSubject: boolean; flat?: boolean }) {
  const id = useId();
  // a row shows when it was disclosed, when it has something in it, or when the mode needs it (a forward's
  // subject): a conversion that fills Cc in while the draft is open shows it, never sends to a hidden field
  const [ccOpen, setCc] = useState(false);
  const [bccOpen, setBcc] = useState(false);
  const [subjectOpen, setSubject] = useState(false);
  const cc = ccOpen || d.ccText !== "";
  const bcc = bccOpen || d.bccText !== "";
  const subject = subjectOpen || showSubject || d.subjectEdited;
  const update = (patch: Partial<DraftFields>) => editDraft(d.key, patch);
  /** a recipient field's change: the addresses the user put in are theirs now, no longer Terno's (Codex review 9) */
  const recipients = (field: "to" | "cc" | "bcc", text: string, authored: readonly string[]) => {
    const auto = authored.length ? { ...d.auto, [field]: d.auto[field].filter((e) => !authored.includes(e.toLowerCase())) } : d.auto;
    update({ [`${field}Text`]: text, ...(auto !== d.auto ? { auto } : {}) } as Partial<DraftFields>);
  };
  const toggle = (open: boolean, set: (v: boolean) => void, label: string, field: string, testId: string) =>
    !open && (
      <button
        type="button"
        aria-expanded="false"
        aria-controls={`${id}-${field}`}
        data-testid={testId}
        onClick={() => {
          set(true);
          requestAnimationFrame(() => document.getElementById(`${id}-${field}`)?.focus());
        }}
        className="h-[22px] rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {label}
      </button>
    );
  return (
    <div className={cn(flat && "hairline-t")} data-draft-key={d.key}>
      {(accounts.length > 1 || !accounts.some((a) => a.id === d.accountId)) && (
        <Row label={t("compose.from")}>
          <Select disabled={d.sending || draftSenderLocked(d)} value={String(d.accountId)} onValueChange={(v) => update({ accountId: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: `${a.displayName} · ${a.email}` }))}>
            <SelectTrigger size="sm" aria-label={t("compose.from")}className="-ml-2 h-7 border-0 bg-transparent shadow-none dark:bg-transparent" data-testid="compose-from" title={draftSenderLocked(d) ? t("attachments.senderLocked") : undefined}>
              <SelectValue />
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
      <Row label={t("compose.to")} htmlFor={`${id}-to`}>
        <RecipientInput id={`${id}-to`} testId="compose-to" label={t("compose.to")} className={input} value={d.toText} onChange={(v, a) => recipients("to", v, a)} placeholder={t("compose.toPlaceholder")} accountId={d.accountId} others={[d.ccText, d.bccText]} />
        <span className="mt-2 flex shrink-0 gap-0.5 self-start">
          {toggle(cc, setCc, t("compose.cc"), "cc", "compose-show-cc")}
          {toggle(bcc, setBcc, t("compose.bcc"), "bcc", "compose-show-bcc")}
          {toggle(subject, setSubject, t("compose.subject"), "subject", "compose-show-subject")}
        </span>
      </Row>
      <Row label={t("compose.cc")} htmlFor={`${id}-cc`} hidden={!cc}>
        <RecipientInput id={`${id}-cc`} testId="compose-cc" label={t("compose.cc")} className={input} value={d.ccText} onChange={(v, a) => (setCc(true), recipients("cc", v, a))} accountId={d.accountId} others={[d.toText, d.bccText]} />
      </Row>
      <Row label={t("compose.bcc")} htmlFor={`${id}-bcc`} hidden={!bcc}>
        <RecipientInput id={`${id}-bcc`} testId="compose-bcc" label={t("compose.bcc")} className={input} value={d.bccText} onChange={(v, a) => (setBcc(true), recipients("bcc", v, a))} accountId={d.accountId} others={[d.toText, d.ccText]} />
      </Row>
      <Row label={t("compose.subject")} htmlFor={`${id}-subject`} hidden={!subject}>
        <input id={`${id}-subject`} data-testid="compose-subject" className={input} value={d.subject} onChange={(e) => update({ subject: e.target.value, subjectEdited: true })} />
      </Row>
    </div>
  );
}

/** What the draft's save state says, for screen readers too: "saved" only for an acknowledged revision. */
export function SaveState({ d }: { d: LocalDraft }) {
  const held = useDrafts((s) => s.held);
  const action = useRef<HTMLButtonElement | null>(null);
  const actionRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node && action.current === document.activeElement) {
      const controller = controllerFor(d.key);
      if (controller) controller.focus("keep");
      else action.current?.closest("form")?.querySelector<HTMLElement>("[data-testid=compose-body-loading]")?.focus();
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
        <button
          ref={actionRef}
          type="button"
          data-testid="draft-save-copy"
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          aria-busy={recovery.state === "copying"}
          aria-disabled={recovery.state === "copying"}
          onClick={() => { if (recovery.state !== "copying") void copyDraft(d.key); }}
        >
          {t(recovery.state === "unknown" ? "compose.recovery.another" : "compose.recovery.copy")}
        </button>
      )}
      {!recovery && d.status === "error" &&
        richT(d.tooLong ? "compose.status.tooLong" : "compose.status.failed", {
          retry: (text) => (
            <button type="button" className="font-medium text-foreground underline underline-offset-2 hover:no-underline" onClick={() => retryDraft(d.key)}>
              {text}
            </button>
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
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => editDraft(d.key, { includeQuote: true })}>
              {text}
            </button>
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
            <button type="button" className="mt-2 block text-xs font-medium text-primary hover:underline" onClick={() => editDraft(d.key, { includeQuote: false })} data-testid="compose-quote-remove">
              {t("compose.quote.remove")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolIcon({ label, keys, onClick, children, testId, disabled }: { label: string; keys?: string; onClick: () => void; children: React.ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} data-testid={testId} disabled={disabled} className="text-muted-foreground hover:text-foreground">
            {children}
          </Button>
        }
      />
      <TooltipContent>
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
  );
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
export function DraftSlot({ threadId, draftKey, replyTo, account, icons = true, checkpoint }: { threadId: number; draftKey: string | null; replyTo: string; account: Account | undefined; icons?: boolean; checkpoint?: BodyCheckpoint }) {
  const d = useDrafts((s) => (draftKey ? s.drafts[draftKey] : undefined));
  const accounts = useApp((s) => s.accounts);
  const focus = useApp((s) => (draftKey && s.draftFocus?.key === draftKey ? s.draftFocus : null));
  const rootRef = useRef<HTMLDivElement>(null);
  const formatId = useId();
  const state: "bar" | "open" | "collapsed" = !d ? "bar" : d.uiState;

  // a conversation is open: its reply may come next, so the editor starts loading (once)
  useEffect(preloadComposer, []);
  // a draft is open: suggestions get ready (once per session)
  useEffect(() => {
    if (state === "open") warmAutocomplete();
  }, [state]);

  // an explicit open (r/a/f, the bar, the menu) asks for focus: honor it once
  useEffect(() => {
    if (!focus || !d) return;
    focusSoon(focus.target === "to" ? "[data-testid=compose-to]" : "[data-testid=compose-body]", rootRef.current);
    setApp({ draftFocus: null });
  }, [focus?.seq]);

  const collapse = () => {
    if (!d) return;
    supersedeCompose();
    setDraftUi(d.key, "collapsed");
    void flushDraft(d.key);
    focusSoon("[data-testid=draft-collapsed]", rootRef.current);
  };
  const reopen = () => {
    if (!d) return;
    setDraftUi(d.key, "open");
    focusSoon("[data-testid=compose-body]", rootRef.current);
  };
  const send = async () => {
    if (!d) return;
    const ok = await sendDraft(d.key);
    if (ok) focusSoon("[data-testid=quick-reply]", rootRef.current);
  };
  const discard = async () => {
    if (!d) return;
    const gone = await discardDraft(d.key);
    focusSoon("[data-testid=quick-reply]", rootRef.current);
    if (!gone) return;
    const undo = registerUndo(() => restoreDiscarded(gone));
    snack(t("compose.discarded"), { action: { label: t("common.undo"), name: t("compose.undoDiscard"), undo } });
  };

  const me = account?.displayName || account?.email || "";
  const who = d ? d.toText.split(",")[0]?.replace(/<.*$/, "").replace(/"/g, "").trim() || d.toText : "";
  const label = !d ? "" : d.mode === "new" ? t("compose.newMessage") : formLabel(d.mode === "forward", who);

  return (
    <div ref={rootRef} className="mt-5 rounded-xl bg-(--draft-bg) [box-shadow:0_0_0_var(--hairline-w)_var(--draft-ring),var(--draft-shadow)]" data-testid="draft-slot" data-state={state} data-thread={threadId}>
      <Expand open={state === "bar"}>
        <div className="flex h-10 items-center gap-0.5 pr-1.5 pl-2.5" data-testid="reply-bar">
          <button type="button" onClick={() => void openCompose("reply", threadId)} data-testid="quick-reply" className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left text-sm text-muted-foreground">
            <SenderAvatar name={me} email={account?.email ?? me} icon={icons} className="size-[22px] text-[9.5px]" />
            <span className="truncate">{t("compose.bar.reply", { name: replyTo })}</span>
          </button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("replyAll", threadId)} data-testid="quick-reply-all">
            <ReplyAll /> {t("compose.bar.replyAll")}
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("forward", threadId)} data-testid="quick-forward">
            <Forward /> {t("compose.bar.forward")}
          </Button>
        </div>
      </Expand>
      <Expand open={state === "collapsed"}>
        {d && (
          <button type="button" onClick={reopen} data-testid="draft-collapsed" aria-expanded="false" className="flex h-10 w-full items-center gap-2 rounded-xl pr-3 pl-3 text-left text-sm">
            <PenLine className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">{t("compose.draft")}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t(d.mode === "forward" ? "compose.collapsed.forward" : "compose.collapsed.to", { to: recipientSummary(d.toText) || "—", preview: d.bodyText.split("\n").find((l) => l.trim()) ?? "" })}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </Expand>
      <Expand open={state === "open"} onOpening={(el) => keepInView(el)}>
        {d && (
          <form
            aria-label={label}
            data-testid="composer"
            data-mode={d.mode}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            onKeyDown={(e) => {
              // keys from a popover or menu (portaled: React still bubbles them here) aren't the composer's; the editor
              // itself prevents every Enter and Esc (ProseMirror's own), so defaultPrevented can't tell
              if (!e.currentTarget.contains(e.target as Node) || e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && !popupOpen()) {
                e.preventDefault();
                e.stopPropagation();
                collapse();
              }
            }}
          >
            <DraftFieldsForm d={d} accounts={accounts} showSubject={d.mode === "forward" || d.mode === "new"} />
            <ComposerBody draftKey={d.key} checkpoint={checkpoint} placeholder={d.mode === "new" ? t("compose.bodyPlaceholder.new") : d.mode === "forward" ? t("compose.bodyPlaceholder.forward") : t("compose.bodyPlaceholder.reply")} className="block min-h-[132px] w-full px-3.5 pt-3 pb-1 text-base" />
            <DraftAttachments d={d} />
            <SignaturePreview accountId={d.accountId} className="px-3.5 pb-2" />
            <Quote d={d} />
            <ComposerFormatBar draftKey={d.key} id={formatId} className="px-2 pt-1.5" />
            <div className="flex items-center gap-1 px-2.5 pt-2 pb-2.5">
              <Button type="submit" size="sm" data-testid="compose-send" aria-busy={d.sending} disabled={d.sending || Boolean(d.recovery)} className="mr-1.5 gap-2">
                <Send /> {t("common.send")} <Shortcut keys="mod+enter" className="[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
              </Button>
              <FormatToggle controls={formatId} />
              <AttachButton d={d} />
              <LinkButton draftKey={d.key} disabled={d.sending} />
              <span className="ml-1.5 min-w-0">
                <SaveState d={d} />
              </span>
              <span className="ml-auto flex gap-0.5">
                <ToolIcon label={t("compose.discard")} onClick={() => void discard()} testId="compose-discard" disabled={d.sending}>
                  <Trash2 />
                </ToolIcon>
                <ToolIcon label={t("compose.collapse")} keys="escape" onClick={collapse} testId="compose-collapse">
                  <ChevronDown />
                </ToolIcon>
              </span>
            </div>
          </form>
        )}
      </Expand>
    </div>
  );
}
