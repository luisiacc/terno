import { AttachButton, DraftAttachments } from "./attachments";
import { useComposerDrop } from "./composer-drop";
import { t } from "@terno/i18n";
import { IconButton } from "@terno/ui/components/icon-button";
import { isSendLaterKey, openSendLater, SendButton, SendOrAsk } from "./send-button";
import { cn } from "@terno/ui/lib/utils";
import { Trash2 } from "@terno/ui/icons";
import { useEffect, useId, useRef } from "react";
import { registerUndo, snack } from "~/lib/snack";
import { composeFocusPending, finishComposeFocus, leaveNewDraft, leaveNewDraftWithFocus, resumeTarget, sendDraft, showNewDraft } from "~/lib/compose";
import { discardDraft, restoreDiscarded, useDrafts } from "~/lib/drafts";
import { setApp, useApp } from "~/state/app";
import { DRAFT_SURFACE, DraftClose, DraftFieldsForm, DraftPin, focusSoon, Quote, SaveState, SignaturePreview } from "./inline-draft";
import { popupOpen } from "./composer/controller";
import { ComposerFormatBar, FormatToggle, LinkButton } from "./composer/controls";
import { RichBody } from "./composer/rich";
import { warmAutocomplete } from "~/lib/autocomplete";
import { DraftCommandsHost } from "~/lib/draft-commands";
import { pinDraft } from "~/lib/pinned-draft";
import { AiDraftButton } from "./composer/ai-slot";
import { aiDraftHooks } from "~/lib/ai-draft-state";
import { focusSelector } from "~/lib/compose-focus-move";
import { cancelEmptySend } from "~/lib/send-problem";
import { PANE_TITLE, PANE_TITLE_AFTER, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";

/** Esc, Collapse and sending leave the new message; focus goes to its strip item (kept) or back to the list. */
function leave(key: string) {
  const request = leaveNewDraftWithFocus(key);
  if (request?.valid()) focusSoon(`[data-testid=strip-item][data-key="${key}"]`, null, 12, () => true, request.valid, request.watch);
}

/**
 * A new message, written in the reader pane as a conversation's draft is
 * (plan 130): a title that mirrors the subject over the same card, which hugs
 * its text so the format bar and Send stay next to it. A long message scrolls
 * inside the card, under its fixed foot. The draft stays in the strip above
 * the list while another conversation is read.
 */
export function NewMessage() {
  const compose = useApp((s) => s.compose);
  const d = useDrafts((s) => (compose ? s.drafts[compose.key] : undefined));
  const accounts = useApp((s) => s.accounts);
  const rootRef = useRef<HTMLFormElement>(null);
  const sendWatches = useRef(new Set<() => void>());
  const formatId = useId();
  const focusGeneration = useRef(0);

  useEffect(() => () => { for (const stop of sendWatches.current) stop(); }, []);
  // a new message: suggestions get ready (once per session)
  useEffect(warmAutocomplete, []);
  useEffect(() => {
    if (!compose) return;
    const generation = ++focusGeneration.current;
    const owned = compose.storedFocusSeq === undefined ? null : { key: compose.key, seq: compose.storedFocusSeq };
    focusSoon(focusSelector(compose.target ?? resumeTarget(compose.key)), rootRef.current, 12, owned ? (fallback) => focusGeneration.current === generation && finishComposeFocus(owned.key, owned.seq, fallback) : undefined, owned ? () => focusGeneration.current === generation && useApp.getState().compose === compose && composeFocusPending(null, owned.key, owned.seq) : undefined);
    if (owned && useApp.getState().draftFocus?.seq === owned.seq) setApp({ draftFocus: null });
    return () => {
      if (owned) queueMicrotask(() => { if (focusGeneration.current === generation) finishComposeFocus(owned.key, owned.seq, false); });
    };
  }, [compose?.seq]);

  const drop = useComposerDrop(compose?.key ?? "", d?.sending ?? false);
  if (!compose || !d) return null;
  const key = compose.key;
  const send = async (sendAt?: number) => {
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
      const ok = await sendDraft(key, sendAt);
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
      data-draft-key={key}
      data-mode="new"
      className="@container flex h-full min-h-0 flex-col bg-background animate-in fade-in-0 slide-in-from-bottom-1 duration-base"
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
          openSendLater(key);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        } else if (e.key === "Escape" && !popupOpen()) {
          e.preventDefault();
          e.stopPropagation();
          // Send's question first (plan 158), then the AI row: it stops a stream, closes itself (§10.4)
          if (!cancelEmptySend(key) && !aiDraftHooks.escape(key)) leave(key);
        }
      }}
    >
      {/* the window's drag strip, and what this is: the subject is in its field, once (plan 158). Plan 160: the title on the
          reader subject's line (the toolbar's row, the gap), on the same column */}
      <div className="drag-region shrink-0 [scrollbar-gutter:stable] overflow-y-hidden">
        <div className={cn(READING_COLUMN, PANE_TITLE_TOP)}>
          {/* the pane's heading, as a conversation's subject is: what the pane is doing now (plan 158) */}
          <h2 className={cn(PANE_TITLE, PANE_TITLE_AFTER, "truncate")} data-testid="compose-title">
            {t("compose.untitled")}
          </h2>
        </div>
      </div>
      {/* scrolls only where the card's minimum doesn't fit (a short window under a tall pinned card) */}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {/* pt-0.5: the card's ring is drawn outside it, so the scroller's top edge would cut it (plan 158); pb: its foot keeps the floating inset */}
        <div className={cn(READING_COLUMN, "flex h-full flex-col pt-0.5 pb-(--float-inset)")}>
          {/* plan 158: a card that holds its text, Send just under it. The owner (after plan 160, which stretched it to the
              pane's foot: "too tall, it looks bad"): it's as tall as what it holds, from a comfortable empty body, and
              grows as you write up to the pane; past that a long message scrolls inside it, the bar and Send in view */}
          <div className={cn("relative flex min-h-60 cursor-text flex-col", DRAFT_SURFACE)} data-testid="composer-card">
            {/* pt-0.5: the first row's text field keeps its whole focus ring */}
            <div className="min-h-0 overflow-y-auto pt-0.5" data-draft-scroll>
              <DraftFieldsForm d={d} accounts={accounts} showSubject />
              <RichBody draftKey={key} placeholder={t("compose.bodyPlaceholder.new")} className="rt-measure block min-h-[max(180px,28vh)] w-full px-3.5 pt-3 pb-3" />
              <DraftAttachments d={d} />
              <SignaturePreview accountId={d.accountId} className="px-3.5 pb-2" />
              <Quote d={d} />
            </div>
            <div className="mt-auto shrink-0">
              <ComposerFormatBar draftKey={key} id={formatId} className="px-2 pt-1.5" />
              {/* wraps: the status can hold a recovery action, and a narrow pane still reaches Discard */}
              <div className="@container/foot flex flex-wrap items-center gap-1 px-2.5 pt-2 pb-2.5">
                <SendOrAsk d={d} onSend={(at) => void send(at)}>
                  <SendButton d={d} onSend={(at) => void send(at)} className="mr-1.5 @max-[31rem]/foot:mr-0" />
                  <AiDraftButton draftKey={key} disabled={d.sending} testId="compose-ai" />
                  <FormatToggle controls={formatId} />
                  <AttachButton d={d} />
                  <LinkButton draftKey={key} disabled={d.sending} />
                  <span className="ml-1.5 flex min-w-0">
                    <SaveState d={d} />
                  </span>
                  <span className="ml-auto flex gap-0.5">
                    {/* plan 115: kept at the bottom right while conversations are read */}
                    <DraftPin pinned={false} onClick={() => pinDraft(key)} disabled={d.sending} />
                    <IconButton label={t("compose.discard")} onClick={() => void discard()} data-testid="compose-discard" disabled={d.sending}>
                      <Trash2 />
                    </IconButton>
                    <DraftClose onClick={() => leave(key)} />
                  </span>
                </SendOrAsk>
              </div>
            </div>
            {drop.layer}
          </div>
        </div>
      </div>
      <DraftCommandsHost draftKey={key} root={rootRef} send={(at) => void send(at)} discard={() => void discard()} close={() => leave(key)} sending={d.sending} />
    </form>
  );
}
