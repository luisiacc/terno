import { defaultRemindAt, type FollowupRow, type MessageDetail, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, CalendarClock, ChevronDown, Clock } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { followupsOffered, modelName } from "~/lib/ai";
import { whenDate } from "~/lib/when";
import { useCanDraft } from "~/lib/ai-draft-state";
import { laterPresets } from "~/lib/dated";
import { actOnFollowup, followupLine, followupWhen, mayHaveArrived, owedLate } from "~/lib/followups";
import { useDrafts } from "~/lib/drafts";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { revealSummaryMessage } from "~/lib/summaries";
import { nudge, nudgeDraft, nudgeState, openNudge } from "~/lib/followup-nudge";
import { useAiDraft } from "~/lib/ai-draft";
import { offerTip, usePendingTip } from "~/lib/tips";
import { useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { AI_ACTIONS, AI_CARD, AI_GLYPH, AI_HEADER, AI_PAD, AI_TITLE, AiProvenance, messageSource } from "./ai-card";
import FollowupsTip from "./followups-tip";
import { WhenForm } from "./when-fields";

/**
 * Plan 161: the line in the AI suggestions' anatomy. Pass 3: on their card too, as Reply ready is (plan 148 left a card out
 * of its scope; raters read the bare line as mail metadata): the fact is the title ("Waiting for Arjun’s reply", plan 162), when it
 * comes back is under it, then the buttons, the source, and who found it at the row's end. A wait's only: a promise of yours
 * is on the reader's line (plan 210, iteration 3).
 */
function Line({ row, messages }: { row: FollowupRow; messages: readonly MessageDetail[] }) {
  // plan 280 (§6): a promise of theirs that may have been kept asks first, and offers no reminder
  const theirs = row.kind === "theirs";
  const arrived = mayHaveArrived(row, messages);
  const name = row.personName?.split(/\s+/)[0] || row.personEmail?.split("@")[0] || t("followup.someone");
  const line = arrived === "wrote" ? t("followup.theirsWroteSince", { name }) : arrived === "notice" ? t("followup.theirsMayHaveArrived") : followupLine(row);
  // a reminder only for a firm one that's late, and no service said it arrived; the QA panel: their mail since asks
  // first (Done leads) but keeps the reminder, since their mail is often about something else
  const offersNudge = !theirs || (row.state === "due" && row.firm !== false && arrived !== "notice");
  // the one filled button is the likeliest step: Done when something says it may have come, else the reminder
  const doneFirst = theirs && arrived !== null;
  const nudgeVariant = doneFirst ? "outline" : "default";
  const nudgeTone = doneFirst ? "text-foreground" : undefined;
  // when it comes back
  const when = followupWhen(row);
  // plan 147: a follow-up stays readable when its key goes; a nudge is a draft, and can't be written
  const canNudge = useCanDraft({ threadId: row.threadId });
  const now = new Date();
  // any moment ahead
  const later = laterPresets({ before: null, limit: null }, now.getTime());
  const mine = useApp((s) => s.accounts).map((a) => a.email);
  // the QA panel: the mail the card speaks of: the service's notice it asks about, the debtor's mail that gave it its day, or the promise's own
  const target = [arrived === "notice" ? row.arrivedHint : null, row.movedBy, row.messageId].find((id) => id != null && messages.some((m) => m.id === id)) ?? row.messageId;
  const source = messageSource(messages, target, mine);
  // the nudge Write a follow-up made, still a draft: the line offers it rather than another
  const drafted = useDrafts((s) => nudgeDraft(row.id, s.drafts) !== null);
  // plan 162 (after ai162-r03): "Open your follow-up" only once it has words; while the composer asks or writes, the
  // card says so and takes you to that draft (it offered to open it over an empty body)
  const nudging = useAiDraft((s) => (drafted ? nudgeState(s.sessions[nudgeDraft(row.id) ?? ""]?.phase) : null));
  const laterRef = useRef<HTMLButtonElement>(null);
  // its own moment starts where the reminder's own picker does (plan 87): the next sensible moment, never one already past
  const [picking, setPicking] = useState(false);
  return (
    <div data-testid="followup-line" data-kind={row.kind} data-state={row.state} data-firm={theirs ? String(row.firm !== false) : undefined} data-arrived={arrived ?? undefined} className={cn(AI_CARD, AI_PAD)}>
      {/* the news first, at the text's size: it's what the card is */}
      <p data-testid="followup-header" className={AI_HEADER}>
        <Clock aria-hidden className={cn(AI_GLYPH, "text-sm")} />
        <span data-testid="followup-text" className={cn(AI_TITLE, "text-sm")}>{line}</span>
      </p>
      {/* plan 280: a promise of theirs says what it is ("Alex promised to send you the contract") under the question */}
      {arrived !== null && <p data-testid="followup-promised" className="text-sm text-muted-foreground">{followupLine(row)}</p>}
      {/* the second QA round: late for certain, the day in the list's owed ink (it went grey where you act) */}
      {when && <p data-testid="followup-due" className={cn("text-sm tabular", owedLate(row) && arrived === null ? "text-draft-foreground" : "text-muted-foreground")}>{when}</p>}
      <div className={cn(AI_ACTIONS, "mt-3")} data-testid="followup-actions">
        {/* plan 280: Done first for a promise of theirs (the QA panel: "Received" was wrong for a call or an answer) */}
        {theirs && (
          <Button size="sm" variant={doneFirst ? "default" : "outline"} className={doneFirst ? undefined : "text-foreground"} data-testid="followup-done" onClick={() => void actOnFollowup(row, "done")}>
            {t("followup.done")}
          </Button>
        )}
        {!offersNudge ? null : drafted && nudging === "writing" ? (
          // plan 162 (after ai162-r05): its words without a spinner: the composer's "Writing…" is the one working mark
          <Button size="sm" variant="outline" className="text-foreground" data-testid="followup-nudging" aria-disabled onClick={() => void openNudge(row.id)}>{t("followup.nudging")}</Button>
        ) : drafted && nudging === "waiting" ? (
          <Button size="sm" variant={nudgeVariant} className={nudgeTone} data-testid="followup-nudge" onClick={() => void openNudge(row.id)}>{t("followup.nudge")}</Button>
        ) : drafted ? (
          <Button size="sm" variant={nudgeVariant} className={nudgeTone} data-testid="followup-open-nudge" onClick={() => void openNudge(row.id)}>{t("followup.openNudge")}</Button>
        ) : (
          canNudge && <Button size="sm" variant={nudgeVariant} className={nudgeTone} data-testid="followup-nudge" onClick={() => void nudge(row)}>{t("followup.nudge")}</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button ref={laterRef} size="sm" variant="outline" className="text-foreground" data-testid="followup-later" />}>
            {t("followup.later")}
            <ChevronDown aria-hidden />
          </DropdownMenuTrigger>
          {/* pass 3: as wide as what it holds (it was the trigger's 128 px, and clipped its labels): BoardUI's label and
              shortcut row, the moment each resolves to in the shortcut's place, and nothing in it shrinks */}
          <DropdownMenuContent align="start" className="w-max" data-testid="followup-later-menu">
            {later.map((p) => (
              <DropdownMenuItem key={p.id} data-testid={`followup-later-${p.id}`} onClick={() => void actOnFollowup(row, "later", p.at)}>
                <span className="whitespace-nowrap">{presetLabel(p.id)}</span>
                <DropdownMenuShortcut data-testid="followup-later-when" className="tracking-normal whitespace-nowrap tabular-nums">{presetWhen(p, now.getTime())}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            {/* plan 162: any moment, with the reminder's own date and time (plan 87): the four presets couldn't say one */}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="followup-later-pick" onClick={() => setPicking(true)}>
              <CalendarClock aria-hidden />
              <span className="whitespace-nowrap">{t("remind.pick")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover open={picking} onOpenChange={(open) => { setPicking(open); if (!open) laterRef.current?.focus({ preventScroll: true }); }}>
          <PopoverContent anchor={laterRef} align="start" className="w-80" data-testid="followup-later-custom" aria-label={t("followup.later")}>
            <WhenForm
              start={defaultRemindAt(new Date())}
              testPrefix="followup-later"
              submit={t("dated.laterSet")}
              onSet={(at) => {
                setPicking(false);
                laterRef.current?.focus({ preventScroll: true });
                void actOnFollowup(row, "later", at);
              }}
            />
          </PopoverContent>
        </Popover>
        {/* a nudge's dismissal keeps its words and weight: it isn't a task; a promise of theirs read wrong is Not a promise */}
        <Button size="sm" variant="outline" className="text-foreground" data-testid="followup-dismiss" onClick={() => void actOnFollowup(row, "dismiss")}>
          {t(theirs ? "followup.notAPromise" : "followup.dismiss")}
        </Button>
        {/* where it came from, named ("Your message, Oct 22"), its words (the quote) on hover; nothing when it's the one
            message on screen. The QA panel: it and who found it are one line of their own under the buttons, on every card
            (source on the card's text line, provenance at its end), never beside the buttons on one card and below on another */}
        <span data-testid="followup-meta" className="flex min-w-max basis-full items-center gap-2">
          {source !== null && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="sm" data-testid="followup-go" className="-ms-2.5 text-muted-foreground hover:text-foreground" onClick={() => revealSummaryMessage(target)} />}>
                {source}
                <ArrowRight aria-hidden />
              </TooltipTrigger>
              {row.quote && target === row.messageId && <TooltipContent data-testid="followup-quote">{row.quote}</TooltipContent>}
            </Tooltip>
          )}
          {row.model && (
            <AiProvenance
              model={row.model}
              at={row.createdAt}
              label={t("ai.provenance.found")}
              detail={t("ai.provenance.foundDetail", { model: modelName(row.model), date: whenDate(row.createdAt) })}
              testId="followup-provenance"
              className="-me-1.5 ms-auto"
            />
          )}
        </span>
      </div>
    </div>
  );
}

const NO_ROWS: readonly FollowupRow[] = [];

export interface FollowupCards {
  shown: readonly FollowupRow[] | undefined;
  waits: readonly FollowupRow[];
}

/**
 * The conversation's follow-ups the reader may show (`shown`: none while they're off for its account, or it's in Trash or
 * Spam), and the ones with a card of their own here (`waits`): a wait, and (plan 280) what's owed to you. Plan 296: the
 * reader's count reads the same, resolved once in `Thread`.
 */
export function useFollowupCards(detail: ThreadDetail): FollowupCards {
  const enabled = useApp((s) => followupsOffered(s, detail.thread.accountId));
  const rows = useFollowups((s) => s.byThread.get(detail.thread.id));
  const shown = enabled && !detail.thread.inTrash && !detail.thread.inSpam ? rows : undefined;
  return { shown, waits: shown?.filter((r) => r.kind === "awaiting" || r.kind === "theirs") ?? NO_ROWS };
}

/**
 * Plan 142 §7: a quiet card for each wait in this conversation, above its summary; plan 280, for each promise of theirs. Plan 210 (iteration 3, Codex revision
 * 10): a promise of yours is one of the conversation's items, on the reader's line with its dated ones (`ThreadItems`); a
 * nudge (waiting on their reply) isn't a task, and keeps its card here.
 */
export default function ThreadFollowups({ detail, cards }: { detail: ThreadDetail; cards: FollowupCards }) {
  const { shown, waits } = cards;
  const tipFor = usePendingTip("followups-first");
  const fresh = shown?.some((r) => !r.fromScan);
  useEffect(() => {
    if (fresh) offerTip("followups-first", detail.thread.id);
  }, [fresh, detail.thread.id]);
  const tip = tipFor === detail.thread.id ? shown?.[0] : undefined;
  if (!waits.length && !tip) return null;
  return (
    // no hairline of its own: the message's divider under it would make two
    <section className="mb-4 space-y-3" aria-label={t("followups.title")} data-testid="thread-followups">
      {waits.map((row) => (
        <Line key={row.id} row={row} messages={detail.messages} />
      ))}
      {tip && <FollowupsTip kind={tip.kind} name={tip.personName?.split(/\s+/)[0] || null} />}
    </section>
  );
}
