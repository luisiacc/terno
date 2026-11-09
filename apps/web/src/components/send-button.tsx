import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Clock, Send, Sparkles } from "@terno/ui/icons";
import { openAiDraft } from "~/lib/ai-draft";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useFilesOnTheirWay } from "~/lib/attachments";
import { emptyMessage, validRecipients, type LocalDraft } from "~/lib/drafts";
import { clearEmptySend, useEmptySend } from "~/lib/send-problem";
import { firstInvalid } from "~/lib/recipient-field";
import { SendLaterPicker } from "./send-later-picker";

/** Plan 94: which composer's Send later is open (⌘⇧↩ opens it from the keyboard). */
export const useSendLater = create<{ open: string | null }>(() => ({ open: null }));
export const openSendLater = (key: string) => useSendLater.setState({ open: key });

/** ⌘⇧↩ (before ⌘↩: both are a modified Enter) */
export const isSendLaterKey = (e: React.KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey;

/** Whether the draft has what a send needs: somebody to go to, and nothing typed that isn't an address. */
export const canSendTo = (d: Pick<LocalDraft, "toText" | "ccText" | "bccText">): boolean =>
  validRecipients(d.toText).length > 0 && firstInvalid(d.toText) === null && firstInvalid(d.ccText) === null && firstInvalid(d.bccText) === null;

/**
 * Send, and joined to its right the clock that schedules it (plan 94): one
 * filled shape split by a short inset hairline, like a macOS split button.
 * The clock opens Send now, Tomorrow at 8:00 and Custom above it. With nobody
 * to send to yet it reads as unavailable, but a click still says why, at the
 * field (plan 158): aria-disabled, never disabled.
 */
export function SendButton({ d, onSend, className }: { d: LocalDraft; onSend: (sendAt?: number) => void; className?: string }) {
  const open = useSendLater((s) => s.open === d.key);
  const setOpen = (o: boolean) => useSendLater.setState({ open: o ? d.key : null });
  const disabled = d.sending || Boolean(d.recovery);
  const uploading = useFilesOnTheirWay(d.key);
  const ready = canSendTo(d) && !uploading;
  const invalid = firstInvalid(d.toText) ?? firstInvalid(d.ccText) ?? firstInvalid(d.bccText);
  // the group owns the fill (a primary button's, plan 118), radius and shadow, so the halves meet with no seam; each half
  // only tints on hover (bg-none: a half's own gradient would hide that), and keeps the group's look when unavailable (the
  // group fades instead).
  // The group clips, so focus is a ring inside each half, 2 px in so it doesn't read as the half's edge, in the
  // text's color (the ring token is primary itself, 1:1 here).
  const half =
    "border-0 bg-transparent bg-none shadow-none hover:bg-primary-hover aria-expanded:bg-primary-hover focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_2px_var(--primary),inset_0_0_0_3.5px_var(--primary-foreground)] active:not-aria-[haspopup]:scale-100 text-inherit unavailable:bg-transparent unavailable:text-inherit";
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch overflow-hidden rounded-[max(var(--cta-floor),min(var(--ds-radius-md),12px))] bg-primary bg-linear-to-b from-primary-hover to-primary text-primary-foreground dark:from-primary dark:to-primary-hover shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)]",
        // what a primary reads as when it can't go yet (plan 118's unavailable), in a color its label stays readable on; a click still says why
        "has-disabled:bg-none has-disabled:bg-transparent has-disabled:text-muted-foreground has-disabled:shadow-[inset_0_0_0_1px_var(--border)] has-[[aria-disabled=true]]:bg-none has-[[aria-disabled=true]]:bg-transparent has-[[aria-disabled=true]]:text-muted-foreground has-[[aria-disabled=true]]:shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
      data-testid="compose-send-group"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="submit" size="sm" data-testid="compose-send" aria-busy={d.sending} aria-disabled={!disabled && !ready ? true : undefined} disabled={disabled} className={cn(half, !ready && "hover:bg-muted", "peer gap-2 rounded-r-none pr-2")}>
              <Send /> {t("common.send")}
            </Button>
          }
        />
        <TooltipContent className="flex items-center gap-2">
          {ready ? t("common.send") : uploading ? t("compose.stillAdding") : invalid !== null ? t("compose.invalidRecipient", { entry: invalid }) : t("compose.noRecipient")}
          {ready && <Shortcut keys="mod+enter" />}
        </TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button type="button" size="sm" aria-label={t("sendLater.button")} data-testid="compose-send-later" disabled={disabled} className={cn(half, !ready && "hover:bg-muted aria-expanded:bg-muted", "relative gap-0.5 rounded-l-none px-2 before:absolute before:inset-y-1.5 before:left-0 before:w-(--hairline-w) before:bg-current/25 peer-hover:before:opacity-0 hover:before:opacity-0 aria-expanded:before:opacity-0")} />
                }
              />
            }
          >
            <Clock />
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            {t("sendLater.button")}
            <Shortcut keys="mod+shift+enter" />
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="end" sideOffset={6} className="w-72 gap-2 rounded-menu p-1.5" data-testid="send-later-popover" aria-label={t("sendLater.title")}>
          <SendLaterPicker sendKeys="mod+enter" done={() => setOpen(false)} onPick={(at) => onSend(at === "now" ? undefined : at)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Plan 158: a Send with no message asks first, in the action row itself: "Send without a message?", Send and Cancel, in place
 * of the row's controls and at their height. Send (or ⌘↵ again) sends, Undo send as always after; Cancel, Esc or typing put
 * it away, focus back in the text. Otherwise the row as it is (`children`).
 */
export function SendOrAsk({ d, onSend, children }: { d: LocalDraft; onSend: (sendAt?: number) => void; children: React.ReactNode }) {
  const reason = useEmptySend((s) => (s.key === d.key ? (s.reason ?? "empty") : null));
  const empty = emptyMessage(d);
  // a file or a picture came in meanwhile: there's a message now
  useEffect(() => { if (reason === "empty" && !empty) clearEmptySend(d.key); }, [reason, empty, d.key]);
  if (reason === null || (reason === "empty" && !empty) || d.sending) return children;
  return <EmptySendQuestion draftKey={d.key} onSend={onSend} note={reason === "note"} />;
}

/**
 * Plan 158's question, or (plan 162, after ai162-r04) the same question about a note for AI: "This reads as a note for
 * AI." with Write it first (⌘J's, the default) and Send as it is. Esc, Cancel or typing put it away.
 */
function EmptySendQuestion({ draftKey, onSend, note = false }: { draftKey: string; onSend: (sendAt?: number) => void; note?: boolean }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const toText = () => root.current?.closest("form")?.querySelector<HTMLElement>("[data-testid=compose-body]")?.focus({ preventScroll: true });
  useLayoutEffect(() => {
    // asked from Send itself (a click, Enter on it): that button just gave its place, so focus goes to this Send, never lost
    if (!document.activeElement || document.activeElement === document.body) confirm.current?.focus({ preventScroll: true });
    const form = root.current?.closest("form");
    const typed = () => clearEmptySend(draftKey);
    form?.addEventListener("input", typed);
    return () => form?.removeEventListener("input", typed);
  }, [draftKey]);
  const cancel = () => {
    clearEmptySend(draftKey);
    toText();
  };
  const send = () => {
    const at = useEmptySend.getState().sendAt;
    // from the text, as ⌘↵ is: the composer's send puts focus where it goes next from there
    toText();
    onSend(at);
  };
  return (
    <div
      ref={root}
      role="group"
      aria-labelledby={id}
      data-testid="compose-empty-ask"
      className="flex min-w-0 items-center gap-1"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
    >
      <span id={id} role="alert" className="mr-2 truncate pl-1 text-[length:var(--ds-text-control)] font-medium">
        {t(note ? "aiDraft.note.question" : "compose.emptySend.question")}
      </span>
      {note ? (
        <>
          <Button ref={confirm} type="button" size="sm" data-testid="compose-note-write" onClick={() => { clearEmptySend(draftKey); toText(); openAiDraft({ key: draftKey }); }}>
            <Sparkles aria-hidden />
            {t("aiDraft.note.write")}
          </Button>
          <Button type="button" size="sm" variant="outline" data-testid="compose-note-send" onClick={send}>
            {t("aiDraft.note.sendAnyway")}
          </Button>
        </>
      ) : (
        <>
          <Button ref={confirm} type="button" size="sm" data-testid="compose-empty-send" onClick={send}>
            {t("common.send")}
          </Button>
          <Button type="button" size="sm" variant="outline" data-testid="compose-empty-cancel" onClick={cancel}>
            {t("common.cancel")}
          </Button>
        </>
      )}
    </div>
  );
}
