import type { Account } from "@unica/core";
import { Button } from "@unica/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Shortcut } from "@unica/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@unica/ui/components/tooltip";
import { cn } from "@unica/ui/lib/utils";
import { ChevronDown, Forward, PenLine, ReplyAll, Send, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { openCompose, sendDraft } from "~/lib/compose";
import { discardDraft, editDraft, flushDraft, restoreDiscarded, retryDraft, setDraftUi, useDrafts, type DraftFields, type LocalDraft } from "~/lib/drafts";
import { avatarColor, initials } from "~/lib/format";
import { keepInView } from "~/lib/reader-scroll";
import { setLastUndo } from "~/lib/actions";
import { setApp, useApp } from "~/state/app";
import { Expand } from "./expand";

export const AVATAR_BG: Record<string, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  indigo: "bg-cat-indigo/15 text-cat-indigo-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
};

/** Puts focus on an element of the draft area once it is rendered and no longer inert (an opening part is inert for a frame). */
export function focusSoon(selector: string, root: HTMLElement | null, frames = 12) {
  requestAnimationFrame(() => {
    const el = (root ?? document).querySelector<HTMLElement>(selector);
    if ((!el || el.closest("[inert]")) && frames > 0) return focusSoon(selector, root, frames - 1);
    el?.focus({ preventScroll: true });
    if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
  });
}

/** A borderless field row: a real label, the control, hairline below. */
function Row({ label, htmlFor, children, hidden }: { label: string; htmlFor?: string; children: React.ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <div className="hairline-b group/row flex min-h-[38px] items-center gap-2.5 px-3.5">
      <label htmlFor={htmlFor} className="w-14 shrink-0 text-xs text-muted-foreground group-focus-within/row:text-foreground">
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
  const [cc, setCc] = useState(Boolean(d.ccText));
  const [bcc, setBcc] = useState(Boolean(d.bccText));
  const [subject, setSubject] = useState(showSubject || d.subjectEdited);
  const update = (patch: Partial<DraftFields>) => editDraft(d.key, patch);
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
    <div className={cn(flat && "hairline-t")}>
      {accounts.length > 1 && (
        <Row label="De">
          <Select value={String(d.accountId)} onValueChange={(v) => update({ accountId: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: `${a.displayName} · ${a.email}` }))}>
            <SelectTrigger size="sm" aria-label="De" className="-ml-2 h-7 border-0 bg-transparent shadow-none dark:bg-transparent" data-testid="compose-from">
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
      <Row label="Para" htmlFor={`${id}-to`}>
        <input id={`${id}-to`} data-testid="compose-to" className={input} value={d.toText} onChange={(e) => update({ toText: e.target.value })} placeholder="nombre@ejemplo.com" autoComplete="off" />
        <span className="flex shrink-0 gap-0.5">
          {toggle(cc, setCc, "Cc", "cc", "compose-show-cc")}
          {toggle(bcc, setBcc, "Cco", "bcc", "compose-show-bcc")}
          {toggle(subject, setSubject, "Asunto", "subject", "compose-show-subject")}
        </span>
      </Row>
      <Row label="Cc" htmlFor={`${id}-cc`} hidden={!cc}>
        <input id={`${id}-cc`} data-testid="compose-cc" className={input} value={d.ccText} onChange={(e) => update({ ccText: e.target.value })} autoComplete="off" />
      </Row>
      <Row label="Cco" htmlFor={`${id}-bcc`} hidden={!bcc}>
        <input id={`${id}-bcc`} data-testid="compose-bcc" className={input} value={d.bccText} onChange={(e) => update({ bccText: e.target.value })} autoComplete="off" />
      </Row>
      <Row label="Asunto" htmlFor={`${id}-subject`} hidden={!subject}>
        <input id={`${id}-subject`} data-testid="compose-subject" className={input} value={d.subject} onChange={(e) => update({ subject: e.target.value, subjectEdited: true })} />
      </Row>
    </div>
  );
}

/** What the draft's save state says, for screen readers too: «guardado» only for an acknowledged revision. */
export function SaveState({ d }: { d: LocalDraft }) {
  return (
    <span aria-live="polite" className="text-xs text-muted-foreground" data-testid="draft-status">
      {d.status === "saved" && <span className="animate-in fade-in-0 duration-base">Borrador guardado</span>}
      {d.status === "error" && (
        <>
          No se pudo guardar ·{" "}
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => retryDraft(d.key)}>
            Reintentar
          </button>
        </>
      )}
    </span>
  );
}

/** The quoted original: kept apart from the text, shown on demand, removable. */
function Quote({ d }: { d: LocalDraft }) {
  const [show, setShow] = useState(false);
  const id = useId();
  if (!d.quotedText) return null;
  if (!d.includeQuote) {
    return (
      <div className="px-3.5 pb-1 text-xs text-muted-foreground">
        Sin el mensaje citado ·{" "}
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => editDraft(d.key, { includeQuote: true })}>
          Incluirlo
        </button>
      </div>
    );
  }
  return (
    <div className="px-3.5 pb-1">
      <button
        type="button"
        aria-expanded={show}
        aria-controls={id}
        aria-label={show ? "Ocultar el mensaje citado" : "Mostrar el mensaje citado"}
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
              Quitar la cita
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolIcon({ label, keys, onClick, children, testId }: { label: string; keys?: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} data-testid={testId} className="text-muted-foreground hover:text-foreground">
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

/**
 * What follows the last message of a conversation: the reply bar, or the
 * conversation's draft (open, or collapsed into one line). The three share
 * one tinted surface; switching between them animates its rows. Opening
 * keeps the draft in view; focus moves only on an explicit open or exit.
 */
export function DraftSlot({ threadId, draftKey, replyTo, account }: { threadId: number; draftKey: string | null; replyTo: string; account: Account | undefined }) {
  const d = useDrafts((s) => (draftKey ? s.drafts[draftKey] : undefined));
  const accounts = useApp((s) => s.accounts);
  const focus = useApp((s) => (draftKey && s.draftFocus?.key === draftKey ? s.draftFocus : null));
  const rootRef = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const state: "bar" | "open" | "collapsed" = !d ? "bar" : d.uiState;

  // an explicit open (r/a/f, the bar, the menu) asks for focus: honor it once
  useEffect(() => {
    if (!focus || !d) return;
    focusSoon(focus.target === "to" ? "[data-testid=compose-to]" : "[data-testid=compose-body]", rootRef.current);
    setApp({ draftFocus: null });
  }, [focus?.seq]);

  const collapse = () => {
    if (!d) return;
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
    if (!d || sending) return;
    setSending(true);
    const ok = await sendDraft(d.key);
    setSending(false);
    if (ok) focusSoon("[data-testid=quick-reply]", rootRef.current);
  };
  const discard = async () => {
    if (!d) return;
    const gone = await discardDraft(d.key);
    focusSoon("[data-testid=quick-reply]", rootRef.current);
    if (!gone) return;
    const undo = () => restoreDiscarded(gone);
    setLastUndo(undo);
    toast("Borrador descartado", { action: { label: "Deshacer", onClick: undo } });
  };

  const me = account?.displayName || account?.email || "";
  const who = d ? d.toText.split(",")[0]?.replace(/<.*$/, "").replace(/"/g, "").trim() || d.toText : "";
  const label = d && d.mode !== "new" ? `${d.mode === "forward" ? "Reenviar" : "Responder"}${who ? ` a ${who}` : ""}` : "";

  return (
    <div ref={rootRef} className="mt-5 rounded-xl bg-tint" data-testid="draft-slot" data-state={state} data-thread={threadId}>
      <Expand open={state === "bar"}>
        <div className="flex h-10 items-center gap-0.5 pr-1.5 pl-2.5" data-testid="reply-bar">
          <button type="button" onClick={() => void openCompose("reply", threadId)} data-testid="quick-reply" className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left text-sm text-muted-foreground">
            <span className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold", AVATAR_BG[avatarColor(account?.email ?? me)])}>{initials(me)}</span>
            <span className="truncate">Responder a {replyTo}…</span>
          </button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("replyAll", threadId)} data-testid="quick-reply-all">
            <ReplyAll /> Responder a todos
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => void openCompose("forward", threadId)} data-testid="quick-forward">
            <Forward /> Reenviar
          </Button>
        </div>
      </Expand>
      <Expand open={state === "collapsed"}>
        {d && (
          <button type="button" onClick={reopen} data-testid="draft-collapsed" aria-expanded="false" className="flex h-10 w-full items-center gap-2 rounded-xl pr-3 pl-3 text-left text-sm">
            <PenLine className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">Borrador</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              · {d.mode === "forward" ? "Reenviar" : "Para"} {d.toText || "—"} — {d.bodyText.split("\n").find((l) => l.trim()) ?? ""}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </Expand>
      <Expand open={state === "open"} onOpening={(el) => keepInView(el)}>
        {d && d.mode !== "new" && (
          <form
            aria-label={label}
            data-testid="composer"
            data-mode={d.mode}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                collapse();
              }
            }}
          >
            <DraftFieldsForm d={d} accounts={accounts} showSubject={d.mode === "forward"} />
            <textarea
              data-testid="compose-body"
              aria-label="Mensaje"
              value={d.bodyText}
              onChange={(e) => editDraft(d.key, { bodyText: e.target.value })}
              placeholder={d.mode === "forward" ? "Añade un mensaje…" : "Escribe tu respuesta…"}
              className="block min-h-[132px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base outline-none [field-sizing:content] placeholder:text-muted-foreground"
            />
            <Quote d={d} />
            <div className="flex items-center gap-2.5 px-2.5 pt-2 pb-2.5">
              <Button type="submit" size="sm" data-testid="compose-send" aria-busy={sending} className="gap-2">
                <Send /> Enviar <Shortcut keys="mod+enter" className="[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
              </Button>
              <SaveState d={d} />
              <span className="ml-auto flex gap-0.5">
                <ToolIcon label="Descartar borrador" onClick={() => void discard()} testId="compose-discard">
                  <Trash2 />
                </ToolIcon>
                <ToolIcon label="Contraer" keys="escape" onClick={collapse} testId="compose-collapse">
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
