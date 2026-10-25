import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Send, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { registerUndo, snack } from "~/lib/snack";
import { leaveNewDraft, sendDraft, showNewDraft } from "~/lib/compose";
import { discardDraft, editDraft, restoreDiscarded, useDrafts } from "~/lib/drafts";
import { useApp } from "~/state/app";
import { DraftFieldsForm, focusSoon, SaveState, SignaturePreview } from "./inline-draft";

/** Esc and sending leave the new message; focus goes to its strip item (kept) or back to the list. */
function leave(key: string, focusStrip: boolean) {
  leaveNewDraft();
  if (focusStrip) focusSoon(`[data-testid=strip-item][data-key="${key}"]`, null);
  else (document.activeElement as HTMLElement | null)?.blur();
}

/**
 * A new message, written in the reader pane: the toolbar becomes Discard ·
 * Send, a title mirrors the subject, the fields are borderless hairline
 * rows and the body fills the pane. The draft stays in the strip above the
 * list while another conversation is read.
 */
export function NewMessage() {
  const compose = useApp((s) => s.compose);
  const d = useDrafts((s) => (compose ? s.drafts[compose.key] : undefined));
  const accounts = useApp((s) => s.accounts);
  const rootRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (compose) focusSoon("[data-testid=compose-to]", rootRef.current);
  }, [compose?.seq]);

  if (!compose || !d) return null;
  const key = compose.key;
  const send = async () => {
    const ok = await sendDraft(key);
    if (ok) leave(key, false);
  };
  const discard = async () => {
    leaveNewDraft();
    const gone = await discardDraft(key);
    if (!gone) return;
    const undo = registerUndo(() => showNewDraft(restoreDiscarded(gone)));
    snack(t("compose.discarded"), { action: { label: t("common.undo"), name: t("compose.undoDiscard"), undo } });
  };

  return (
    <form
      ref={rootRef}
      aria-label={t("compose.newMessage")}
      data-testid="composer"
      data-mode="new"
      className="flex h-full min-h-0 flex-col bg-background animate-in fade-in-0 slide-in-from-bottom-1 duration-base"
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
          leave(key, true);
        }
      }}
    >
      <div className="drag-region flex h-[52px] shrink-0 items-center gap-3 px-3.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("compose.discard")} disabled={d.sending} onClick={() => void discard()} className="no-drag text-muted-foreground hover:text-foreground" data-testid="compose-discard">
                <Trash2 />
              </Button>
            }
          />
          <TooltipContent>{t("compose.discard")}</TooltipContent>
        </Tooltip>
        <span className="text-sm text-muted-foreground">{t("compose.newMessage")}</span>
        <Button type="submit" size="sm" className="no-drag ml-auto gap-2" data-testid="compose-send" aria-busy={d.sending} disabled={d.sending}>
          <Send /> {t("common.send")} <Shortcut keys="mod+enter" className="[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[860px] flex-col px-7 pt-5 pb-10">
          <h2 className={cn("mb-4 text-xl font-semibold tracking-display text-balance", !d.subject && "text-muted-foreground")} data-testid="compose-title">
            {d.subject || t("compose.untitled")}
          </h2>
          <div className="-mx-3.5">
            <DraftFieldsForm d={d} accounts={accounts} showSubject flat />
          </div>
          <textarea
            data-testid="compose-body"
            aria-label={t("compose.body")}
            value={d.bodyText}
            onChange={(e) => editDraft(key, { bodyText: e.target.value })}
            placeholder={t("compose.bodyPlaceholder.new")}
            className="block min-h-[260px] w-full flex-1 resize-none bg-transparent pt-4 text-base outline-none placeholder:text-muted-foreground"
          />
          <SignaturePreview accountId={d.accountId} className="pt-2" />
          <div className="pt-2">
            <SaveState d={d} />
          </div>
        </div>
      </div>
    </form>
  );
}
