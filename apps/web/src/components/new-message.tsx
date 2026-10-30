import { AttachButton, DraftAttachments } from "./attachments";
import { useComposerDrop } from "./composer-drop";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Send, Trash2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { registerUndo, snack } from "~/lib/snack";
import { composeFocusPending, finishComposeFocus, leaveNewDraft, leaveNewDraftWithFocus, sendDraft, showNewDraft } from "~/lib/compose";
import { discardDraft, restoreDiscarded, useDrafts } from "~/lib/drafts";
import { setApp, useApp } from "~/state/app";
import { DraftFieldsForm, focusSoon, Quote, SaveState, SignaturePreview } from "./inline-draft";
import { popupOpen } from "./composer/controller";
import { ComposerBody, ComposerFormatBar, FormatToggle, LinkButton, preloadComposer } from "./composer/lazy";
import { warmAutocomplete } from "~/lib/autocomplete";

/** Esc and sending leave the new message; focus goes to its strip item (kept) or back to the list. */
function leave(key: string) {
  const request = leaveNewDraftWithFocus(key);
  if (request?.valid()) focusSoon(`[data-testid=strip-item][data-key="${key}"]`, null, 12, () => true, request.valid, request.watch);
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
  const sendWatches = useRef(new Set<() => void>());
  const formatId = useId();
  const focusGeneration = useRef(0);

  useEffect(preloadComposer, []);
  useEffect(() => () => { for (const stop of sendWatches.current) stop(); }, []);
  // a new message: suggestions get ready (once per session)
  useEffect(warmAutocomplete, []);
  useEffect(() => {
    if (!compose) return;
    const generation = ++focusGeneration.current;
    const owned = compose.storedFocusSeq === undefined ? null : { key: compose.key, seq: compose.storedFocusSeq };
    focusSoon("[data-testid=compose-to]", rootRef.current, 12, owned ? (fallback) => focusGeneration.current === generation && finishComposeFocus(owned.key, owned.seq, fallback) : undefined, owned ? () => focusGeneration.current === generation && useApp.getState().compose === compose && composeFocusPending(null, owned.key, owned.seq) : undefined);
    if (owned && useApp.getState().draftFocus?.seq === owned.seq) setApp({ draftFocus: null });
    return () => {
      if (owned) queueMicrotask(() => { if (focusGeneration.current === generation) finishComposeFocus(owned.key, owned.seq, false); });
    };
  }, [compose?.seq]);

  const drop = useComposerDrop(compose?.key ?? "", d?.sending ?? false);
  if (!compose || !d) return null;
  const key = compose.key;
  const send = async () => {
    const original = compose, form = rootRef.current, active = document.activeElement;
    let changed = false, stopped = false;
    const observe = (event: FocusEvent) => { if (event.target !== active) changed = true; };
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.compose !== previous.compose || state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.accountId !== previous.accountId || state.view !== previous.view || state.categoryId !== previous.categoryId || state.reviewCategoryId !== previous.reviewCategoryId || state.query !== previous.query || state.listFilters !== previous.listFilters || state.checked !== previous.checked || state.scope !== previous.scope || state.dialog !== previous.dialog || state.fatal !== previous.fatal) changed = true;
    });
    document.addEventListener("focusin", observe, true);
    const stop = () => { if (stopped) return; stopped = true; unsubscribe(); document.removeEventListener("focusin", observe, true); sendWatches.current.delete(stop); };
    sendWatches.current.add(stop);
    try {
      const ok = await sendDraft(key);
      if (ok && !stopped && !changed && useApp.getState().compose === original && rootRef.current === form && document.activeElement === active) leaveNewDraft();
    } finally { stop(); }
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
      className="relative flex h-full min-h-0 flex-col bg-background animate-in fade-in-0 slide-in-from-bottom-1 duration-base"
      {...drop.handlers}
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
          leave(key);
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
        <Button type="submit" size="sm" className="no-drag ml-auto gap-2" data-testid="compose-send" aria-busy={d.sending} disabled={d.sending || Boolean(d.recovery)}>
          <Send /> {t("common.send")} <Shortcut keys="mod+enter" className="[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-(--reader-max) flex-col px-(--reader-pad-x) pt-5 pb-10">
          <h2 className={cn("type-reader-subject mb-4 text-balance", !d.subject && "text-muted-foreground")} data-testid="compose-title">
            {d.subject || t("compose.untitled")}
          </h2>
          <div className="-mx-3.5">
            <DraftFieldsForm d={d} accounts={accounts} showSubject flat />
          </div>
          <ComposerBody draftKey={key} placeholder={t("compose.bodyPlaceholder.new")} className="block min-h-[260px] w-full flex-1 pt-4 text-base" />
          <DraftAttachments d={d} />
          <Quote d={d} />
          <SignaturePreview accountId={d.accountId} className="pt-2" />
        </div>
      </div>
      {/* the format bar and its toggle stay at hand at the pane's foot while the text scrolls */}
      <div className="shrink-0 px-(--reader-pad-x) pt-2 pb-3">
        <div className="mx-auto flex max-w-(--reader-max) flex-col gap-1.5">
          <ComposerFormatBar draftKey={key} id={formatId} className="-mx-1" />
          <div className="-ml-1.5 flex items-center gap-1">
            <FormatToggle controls={formatId} />
            <AttachButton d={d} />
            <LinkButton draftKey={key} disabled={d.sending} />
            <span className="ml-1.5">
              <SaveState d={d} />
            </span>
          </div>
        </div>
      </div>
      {drop.layer}
    </form>
  );
}
