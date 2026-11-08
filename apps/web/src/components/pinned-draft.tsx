import { AttachButton, DraftAttachments } from "./attachments";
import { useComposerDrop } from "./composer-drop";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Trash2 } from "@terno/ui/icons";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { finishComposeFocus } from "~/lib/compose";
import { sendDraft } from "~/lib/compose";
import { discardDraft, restoreDiscarded, useDrafts } from "~/lib/drafts";
import { DraftCommandsHost } from "~/lib/draft-commands";
import { warmAutocomplete } from "~/lib/autocomplete";
import { focusReading, pinDraft, unpinDraft } from "~/lib/pinned-draft";
import { usePinned } from "~/lib/pinned-draft-state";
import { registerUndo, snack, useSnack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { DraftFieldsForm, DraftPin, focusSoon, Quote, SaveState, SignaturePreview } from "./inline-draft";
import { isSendLaterKey, openSendLater, SendButton, SendOrAsk } from "./send-button";
import { popupOpen } from "./composer/controller";
import { ComposerFormatBar, FormatToggle, LinkButton } from "./composer/controls";
import { RichBody } from "./composer/rich";
import { focusSelector, type InlineFocusMove } from "~/lib/compose-focus-move";
import { AiDraftButton } from "./composer/ai-slot";
import { aiDraftHooks } from "~/lib/ai-draft-state";

/** The card's distance from the pane's edges (px; right-3 bottom-3). */
const GAP = 12;
/** The List layout's snack dock: 30rem at the bottom left (snack-dock.tsx). */
const DOCK_WIDTH = 480;

/** The last focus request the card answered: a remount (Split ↔ List) never takes focus again. */
const answered = { focus: 0 };


/**
 * Plan 115: the pinned draft, docked at the reading area's bottom right while
 * other mail is read. The same parts as the inline draft (fields, editor,
 * attachments, format bar), in a card that floats over the pane; it publishes
 * its height so the reader's end scrolls clear of it.
 */
export function PinnedDraft({ overList }: { /** List's rows show under it (its dock stands on the drafts strip) */ overList: boolean }) {
  const key = usePinned((s) => s.key);
  const focusSeq = usePinned((s) => s.focus);
  const d = useDrafts((s) => (key ? s.drafts[key] : undefined));
  const accounts = useApp((s) => s.accounts);
  const draftFocus = useApp((s) => (key && s.draftFocus?.key === key ? s.draftFocus : null));
  // the dock is in the card's pane in either layout (plan 158)
  const snackInset = useSnack((s) => s.inset);
  const cardRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const move = useRef<InlineFocusMove | null>(null);
  const formatId = useId();
  const titleId = useId();
  const [narrow, setNarrow] = useState(false);

  useEffect(warmAutocomplete, []);
  useEffect(() => () => move.current?.cancel(), []);

  // the snack dock is at the bottom left; where the pane is too narrow for both, the card stands on it, and on what the
  // dock stands on (List's drafts strip, while the list shows: snack-dock)
  const stripLift = useSnack((s) => s.lift);
  const dockLift = overList ? stripLift : 0;
  const lift = narrow ? snackInset + dockLift : 0;
  // the card's height (and its lift) is the scroll end's buffer for whatever reads under it
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const pane = card.parentElement;
    const measure = () => {
      usePinned.setState({ inset: Math.ceil(card.offsetHeight) + GAP * 2 + lift });
      // where the dock's card is (on the reader's column in Split, plan 158), else where it would be
      const dock = pane?.querySelector<HTMLElement>(":scope > [data-testid=snack-dock] [data-snack-card]")?.getBoundingClientRect();
      if (dock && dock.width) setNarrow(dock.right + GAP > card.getBoundingClientRect().left);
      else if (pane) setNarrow(pane.clientWidth < DOCK_WIDTH + card.offsetWidth + GAP * 3);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    if (pane) ro.observe(pane);
    return () => ro.disconnect();
  // (and when List's page comes or goes: the dock moves onto the reader's column and back, its size unchanged)
  }, [key, lift, !!d, overList]);
  useEffect(() => () => usePinned.setState({ inset: 0 }), []);

  // pinned, or asked for (its conversation's reply bar, r/a/f there, the strip): the body takes focus, once per request
  useEffect(() => {
    if (!key || answered.focus === focusSeq) return;
    answered.focus = focusSeq;
    focusSoon("[data-testid=compose-body]", rootRef.current, 12);
  }, [key, focusSeq]);
  // an explicit focus request for this draft (Unpin → pin again, a palette command): honored here, as the slot would
  useEffect(() => {
    if (!draftFocus || useApp.getState().draftFocus !== draftFocus) return;
    const selector = focusSelector(draftFocus.target);
    if (draftFocus.move) {
      if (draftFocus.move.bind(rootRef.current, selector)) move.current = draftFocus.move;
    } else focusSoon(selector, rootRef.current, 12, draftFocus.leased ? (fallback) => finishComposeFocus(draftFocus.key, draftFocus.seq, fallback) : undefined);
    if (useApp.getState().draftFocus === draftFocus) setApp({ draftFocus: null });
  }, [draftFocus?.seq]);

  const drop = useComposerDrop(key ?? "", d?.sending ?? false);
  if (!key || !d) return null;
  /** the card went away with focus in it: reading goes on where it was */
  const away = () => focusReading();
  const send = async (sendAt?: number) => { if (await sendDraft(key, sendAt)) away(); };
  const discard = async () => {
    const gone = await discardDraft(key);
    if (!gone) return;
    away();
    // undo puts it back exactly: pinned, where it was
    const undo = registerUndo(() => { pinDraft(restoreDiscarded(gone)); });
    snack(t("compose.discarded"), { action: { label: t("common.undo"), name: t("compose.undoDiscard"), undo } });
  };
  const who = d.toText.split(",")[0]?.replace(/<.*$/, "").replace(/"/g, "").trim() || d.toText;
  const what = d.mode === "new" ? t("compose.newMessage") : d.mode === "forward" ? (who ? t("compose.form.forward", { name: who }) : t("compose.form.forwardEmpty")) : who ? t("compose.form.reply", { name: who }) : t("compose.form.replyEmpty");

  return (
    <section
      ref={cardRef}
      aria-label={t("compose.pinnedLabel", { name: what })}
      data-testid="pinned-draft"
      data-draft-key={key}
      style={lift ? { bottom: GAP + lift } : undefined}
      className="absolute right-3 bottom-3 z-[6] flex max-h-[min(70%,40rem)] w-[min(32rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-popover animate-in fade-in-0 slide-in-from-bottom-1 duration-base"
    >
      <form
        ref={rootRef}
        aria-labelledby={titleId}
        data-testid="composer"
        data-draft-key={key}
        data-mode={d.mode}
        data-pinned
        className="relative flex min-h-0 flex-1 flex-col"
        {...drop.handlers}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        onKeyDown={(e) => {
          // keys from a popover or menu (portaled: React still bubbles them here) aren't the composer's
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
            // the AI row's first: it stops a stream, closes itself (§10.4)
            if (aiDraftHooks.escape(key)) return;
            // Esc leaves the card (it stays pinned): back to the list, or List's page, so j/k read on
            focusReading(false);
          }
        }}
      >
        <div className="hairline-b flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
          <span id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="pinned-draft-title">
            {what}
            {d.subject && <span className="font-normal text-muted-foreground"> · {d.subject}</span>}
          </span>
          <DraftPin pinned onClick={() => unpinDraft(key)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-draft-scroll>
          <DraftFieldsForm d={d} accounts={accounts} showSubject={d.mode === "forward" || d.mode === "new"} />
          <RichBody draftKey={key} placeholder={d.mode === "new" ? t("compose.bodyPlaceholder.new") : d.mode === "forward" ? t("compose.bodyPlaceholder.forward") : t("compose.bodyPlaceholder.reply")} className="rt-measure block min-h-[132px] w-full px-3.5 pt-3 pb-3" />
          <DraftAttachments d={d} />
          <SignaturePreview accountId={d.accountId} className="px-3.5 pb-2" />
          <Quote d={d} />
        </div>
        <div className="shrink-0">
          <ComposerFormatBar draftKey={key} id={formatId} className="px-2 pt-1.5" />
          <div className="flex items-center gap-1 px-2.5 pt-2 pb-2.5">
            <SendOrAsk d={d} onSend={(at) => void send(at)}>
              <SendButton d={d} onSend={(at) => void send(at)} className="mr-1.5" />
              <FormatToggle controls={formatId} />
              <AttachButton d={d} />
              <LinkButton draftKey={key} disabled={d.sending} />
              <AiDraftButton draftKey={key} disabled={d.sending} testId="compose-ai" />
              <span className="ml-1.5 flex min-w-0">
                <SaveState d={d} />
              </span>
              <span className="ml-auto flex gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("compose.discard")} onClick={() => void discard()} data-testid="compose-discard" disabled={d.sending} className="text-muted-foreground hover:text-foreground">
                        <Trash2 />
                      </Button>
                    }
                  />
                  <TooltipContent>{t("compose.discard")}</TooltipContent>
                </Tooltip>
              </span>
            </SendOrAsk>
          </div>
        </div>
        {drop.layer}
        <DraftCommandsHost draftKey={key} root={rootRef} send={(at) => void send(at)} discard={() => void discard()} sending={d.sending} />
      </form>
    </section>
  );
}
