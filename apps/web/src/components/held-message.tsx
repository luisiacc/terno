import type { AttachmentInfo, MessageDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cardLeaving, copyShown, firstReveal, heldIn, undoHeld, useHeldCard, useHeldSends, type HeldSend } from "~/lib/held-sends";
import { revealHeld } from "~/lib/reader-scroll";
import { useSnack, zHolds } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { PANE_TITLE, PANE_TITLE_AFTER, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { ReaderAttachments } from "./attachments";
import { HtmlBody, TextBody } from "./mail-body";
import { MailReaderView, useMailReaderView } from "./mail-reader-view";
import { OpenHead } from "./message-head";

/**
 * Plan 182: a message just sent, shown at once where its copy will be (the end of its conversation, or a new message's
 * pane), as it will read: the same header family and the same body, signature and quote. Where a message has its date,
 * it says it hasn't gone: the seconds left and Undo, then "Sending…" until its copy takes its place.
 */
export function HeldMessage({ held, icons }: { held: HeldSend; icons: boolean }) {
  const covered = useMailReaderView()?.active != null;
  useHeldCard(held.draftId, !covered);
  const account = useApp((s) => s.accounts.find((a) => a.id === held.accountId));
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? "ask");
  const mailAppearance = useApp((s) => s.settings?.htmlMailAppearance ?? "auto");
  // the reader goes to it once, as it would to its copy; back in the conversation later, the reader keeps its place
  useEffect(() => { if (firstReveal(held.draftId)) revealHeld(held.draftId); }, [held.draftId]);
  // a layout cleanup runs before the card leaves the page: whether focus was in it can still be read (Codex review #3)
  useLayoutEffect(() => () => cardLeaving(held.draftId), [held.draftId]);
  // its own namespace: never a message's id (heights, consent), one per hold
  const bodyId = -held.draftId;
  const files = useMemo<AttachmentInfo[]>(() => held.attachments.map((a, i) => ({ id: -(i + 1), assetId: a.assetId, contentId: a.contentId ?? null, filename: a.filename, mime: a.mime, size: a.size })), [held.attachments]);
  // the name on mail sent from it (From:), as its copy will carry it
  const from = { name: account?.senderName ?? "", email: account?.email ?? "" };
  const sending = held.phase === "sending";
  return (
    <article data-testid="held-message" data-held-send={held.draftId} data-phase={held.phase} tabIndex={-1} aria-label={t("compose.held.label")} className="hairline-b outline-none">
      <div className="relative">
        {/* an open message's header, at its place and height: nothing to open or fold yet */}
        <div className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 px-2 pt-3 pb-1.5">
          <OpenHead from={from} to={held.to} cc={held.cc} icon={icons} person trailing={<HeldStatus held={held} />} recipientsClass="pr-20" />
        </div>
        {/* said once as it changes (never each second): that it hasn't gone and can be taken back, then that it's going */}
        <span role="status" className="sr-only">{sending ? t("compose.sending") : t("compose.held.status")}</span>
        {!sending && <HeldUndo held={held} />}
      </div>
      <div className="pt-2 pb-4">
        {held.bodyHtml ? (
          <HtmlBody html={held.bodyHtml} messageId={bodyId} accountId={held.accountId} attachments={files} remoteImages={remoteImages} appearance={mailAppearance} />
        ) : (
          <TextBody text={held.bodyText} />
        )}
        {files.length > 0 && <ReaderAttachments messageId={bodyId} accountId={held.accountId} attachments={files} />}
      </div>
    </article>
  );
}

/** The seconds left, counted on the window's own end (a tick a second, only while it shows), then "Sending…". */
function HeldStatus({ held }: { held: HeldSend }) {
  const seconds = useSecondsLeft(held.phase === "sending" ? null : held.goesAt);
  return (
    <span data-testid="held-status" className="ml-auto flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground">
      {held.phase === "sending" ? (
        <>
          <Spinner aria-hidden className="size-3 text-muted-foreground" />
          <span>{t("compose.sending")}</span>
        </>
      ) : (
        <span aria-hidden className="tabular">{t("compose.held.sendingIn", { seconds })}</span>
      )}
    </span>
  );
}

function useSecondsLeft(until: number | null): number {
  const left = () => (until === null ? 0 : Math.max(1, Math.ceil((until - Date.now()) / 1000)));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    if (until === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setSeconds(left());
      const rest = until - Date.now();
      // the next whole second, so the figure turns when the time does
      if (rest > 1000) timer = setTimeout(tick, ((rest - 1) % 1000) + 1);
    };
    tick();
    return () => clearTimeout(timer);
  }, [until]);
  return seconds;
}

/** Undo, under the status on the column's edge: the same token z and the dock's snack run; busy while it's taken back. */
function HeldUndo({ held }: { held: HeldSend }) {
  const z = useSnack((s) => zHolds(s, held.undo));
  const undoing = held.phase === "undoing";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            data-testid="held-undo"
            aria-label={t("compose.undoSend")}
            aria-busy={undoing || undefined}
            onClick={() => undoHeld(held.draftId)}
            className={cn("absolute right-0 bottom-0", undoing && "text-muted-foreground")}
          />
        }
      >
        {undoing && <Spinner aria-hidden />}
        {t("common.undo")}
      </TooltipTrigger>
      <TooltipContent>
        {t("compose.undoSend")}
        {z && <Shortcut keys="z" />}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A conversation's held messages, after its messages, in the order sent. One whose copy the conversation shows now has
 * given way to it (the copy renders in its place: same header family, same body).
 */
export function HeldMessages({ threadId, messages, icons }: { threadId: number; messages: readonly MessageDetail[]; icons: boolean }) {
  // the store's own list (stable between changes), narrowed here: a selector that filters would be a new array each read
  const all = useHeldSends((s) => s.holds);
  const holds = useMemo(() => heldIn({ holds: all }, threadId), [all, threadId]);
  const arrived = (h: HeldSend) => h.copy !== null && messages.some((m) => m.id === h.copy!.messageId);
  useEffect(() => {
    for (const h of holds) if (arrived(h)) copyShown(h.draftId);
  }, [holds, messages]);
  return holds.filter((h) => !arrived(h)).map((h) => <HeldMessage key={h.draftId} held={h} icons={icons} />);
}

/**
 * A new message just sent, in the pane it was written in (`heldView`): under its subject, as its conversation will show it,
 * until it goes and that conversation opens on its copy. Focus, left on nothing by the composer going, comes here.
 */
export function HeldNewMessage() {
  const draftId = useApp((s) => s.heldView);
  const held = useHeldSends((s) => s.holds.find((h) => h.draftId === draftId));
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) ref.current?.focus({ preventScroll: true });
  }, []);
  // it went (or was taken back) before the pane was its: nothing to show here (Codex review #1)
  useEffect(() => { if (!held) setApp({ heldView: null }); }, [held]);
  return (
    // the reader's own full-message view, for a long message's "Show full message" (Codex review #5)
    <MailReaderView identity={`held-${draftId}`}>
    <section ref={ref} tabIndex={-1} aria-labelledby="held-title" data-testid="held-view" className="@container flex h-full min-h-0 flex-col bg-background outline-none">
      {/* the title on the pane title's line, as the new message had it and its conversation will */}
      <div className="drag-region shrink-0 [scrollbar-gutter:stable] overflow-y-hidden">
        <div className={cn(READING_COLUMN, PANE_TITLE_TOP)}>
          <h2 id="held-title" className={cn(PANE_TITLE, PANE_TITLE_AFTER, "truncate")} data-testid="held-title">
            {held?.subject || t("common.noSubject")}
          </h2>
        </div>
      </div>
      <div data-reader-scroller className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className={cn(READING_COLUMN, "pb-16")}>
          {held && (
            <div className="hairline-t [--hairline-color:var(--border)]">
              <HeldMessage held={held} icons />
            </div>
          )}
        </div>
      </div>
    </section>
    </MailReaderView>
  );
}
