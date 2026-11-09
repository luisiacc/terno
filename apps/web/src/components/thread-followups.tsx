import { defaultRemindAt, remindPresets, type FollowupRow, type MessageDetail, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, CalendarClock, ChevronDown, Clock } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import { followupsOffered, modelName } from "~/lib/ai";
import { whenDate } from "~/lib/when";
import { useCanDraft } from "~/lib/ai-draft-state";
import { actOnFollowup, followupLine, followupWhen } from "~/lib/followups";
import { useDrafts } from "~/lib/drafts";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { revealSummaryMessage } from "~/lib/summaries";
import { nudge, nudgeDraft, nudgeState, openNudge } from "~/lib/followup-nudge";
import { useAiDraft } from "~/lib/ai-draft";
import { offerTip, usePendingTip } from "~/lib/tips";
import { useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { AI_ACTIONS, AI_CARD, AI_GLYPH, AI_HEADER, AI_TITLE, AiProvenance, messageSource } from "./ai-card";
import FollowupsTip from "./followups-tip";
import { useWhen, WhenFields } from "./when-fields";

/**
 * Plan 161: the line in the AI suggestions' anatomy. Pass 3: on their card too, as Reply ready is (plan 148 left a card out
 * of its scope; raters read the bare line as mail metadata): the fact is the title ("Waiting for Arjun’s reply", plan 162), when it
 * comes back is under it, then the buttons, the source, and who found it at the row's end.
 */
function Line({ row, messages }: { row: FollowupRow; messages: readonly MessageDetail[] }) {
  const line = followupLine(row);
  // plan 147: a follow-up stays readable when its key goes; a nudge is a draft, and can't be written
  const canNudge = useCanDraft();
  const now = new Date();
  const later = remindPresets(now, "always");
  const awaiting = row.kind === "awaiting";
  const mine = useApp((s) => s.accounts).map((a) => a.email);
  const source = messageSource(messages, row.messageId, mine);
  // the nudge Write a follow-up made, still a draft: the line offers it rather than another
  const drafted = useDrafts((s) => (awaiting ? nudgeDraft(row.threadId, s.drafts) !== null : false));
  // plan 162 (after ai162-r03): "Open your follow-up" only once it has words; while the composer asks or writes, the
  // card says so and takes you to that draft (it offered to open it over an empty body)
  const nudging = useAiDraft((s) => (drafted ? nudgeState(s.sessions[nudgeDraft(row.threadId) ?? ""]?.phase) : null));
  const laterRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pastId = useId();
  const [picking, setPicking] = useState(false);
  const [, recheck] = useState(0);
  // it starts where the reminder's own picker does (plan 87): the next sensible moment, never one already past
  const when = useWhen(defaultRemindAt(new Date()));
  return (
    <div data-testid="followup-line" data-kind={row.kind} data-state={row.state} className={cn(AI_CARD, "px-3.5 pb-3")}>
      {/* the news first, at the text's size: it's what the card is */}
      <p data-testid="followup-header" className={AI_HEADER}>
        <Clock aria-hidden className={cn(AI_GLYPH, "text-sm")} />
        <span data-testid="followup-text" className={cn(AI_TITLE, "text-sm")}>{line}</span>
      </p>
      <p data-testid="followup-due" className="text-sm text-muted-foreground tabular">{followupWhen(row)}</p>
      <div className={cn(AI_ACTIONS, "mt-3")} data-testid="followup-actions">
        {awaiting ? (
          drafted && nudging === "writing" ? (
            <Button size="sm" variant="outline" className="text-foreground" data-testid="followup-nudging" aria-disabled onClick={() => void openNudge(row.threadId)}><Spinner aria-hidden className="size-3.5" />{t("followup.nudging")}</Button>
          ) : drafted && nudging === "waiting" ? (
            <Button size="sm" data-testid="followup-nudge" onClick={() => void openNudge(row.threadId)}>{t("followup.nudge")}</Button>
          ) : drafted ? (
            <Button size="sm" data-testid="followup-open-nudge" onClick={() => void openNudge(row.threadId)}>{t("followup.openNudge")}</Button>
          ) : (
            canNudge && <Button size="sm" data-testid="followup-nudge" onClick={() => void nudge(row)}>{t("followup.nudge")}</Button>
          )
        ) : (
          <Button size="sm" data-testid="followup-done" onClick={() => void actOnFollowup(row, "done")}>{t("followup.done")}</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button ref={laterRef} variant="outline" size="sm" className="text-foreground" data-testid="followup-later" />}>
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
            <form
              ref={formRef}
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!when.ready) return;
                // the moment can pass while it's open: the clock again, and a render that says why (as RemindPicker does)
                if (when.chosen <= Date.now()) return recheck((n) => n + 1);
                setPicking(false);
                laterRef.current?.focus({ preventScroll: true });
                void actOnFollowup(row, "later", when.chosen);
              }}
            >
              <WhenFields when={when} testPrefix="followup-later" describedBy={pastId} onEnter={() => formRef.current?.requestSubmit()} />
              {when.past && <p id={pastId} className="text-xs text-destructive-ink" data-testid="followup-later-past">{t("remind.past")}</p>}
              <Button type="submit" size="sm" data-testid="followup-later-set" disabled={when.past || !when.ready} className="self-end">{t("followup.later")}</Button>
            </form>
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="sm" className="text-foreground" data-testid="followup-dismiss" onClick={() => void actOnFollowup(row, "dismiss")}>{t(awaiting ? "followup.dismiss" : "followup.notPromise")}</Button>
        {/* where it came from, named ("Your message, Oct 22"), its words (the quote) on hover; nothing when it's the one
            message on screen */}
        {source !== null && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="sm" data-testid="followup-go" className="text-muted-foreground hover:text-foreground" onClick={() => revealSummaryMessage(row.messageId)} />}>
              {source}
              <ArrowRight aria-hidden />
            </TooltipTrigger>
            {row.quote && <TooltipContent data-testid="followup-quote">{row.quote}</TooltipContent>}
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
      </div>
    </div>
  );
}

/** Plan 142 §7: a quiet line for each thing this conversation holds, in the conversation's text column, above its summary. */
export default function ThreadFollowups({ detail }: { detail: ThreadDetail }) {
  const enabled = useApp(followupsOffered);
  const rows = useFollowups((s) => s.byThread.get(detail.thread.id));
  const shown = enabled && !detail.thread.inTrash && !detail.thread.inSpam ? rows : undefined;
  const tipFor = usePendingTip("followups-first");
  const fresh = shown?.some((r) => !r.fromScan);
  useEffect(() => {
    if (fresh) offerTip("followups-first", detail.thread.id);
  }, [fresh, detail.thread.id]);
  if (!shown?.length) return null;
  return (
    // no hairline of its own: the message's divider under it would make two
    <section className="mb-4 space-y-3" aria-label={t("followups.title")} data-testid="thread-followups">
      {shown.map((row) => (
        <Line key={row.id} row={row} messages={detail.messages} />
      ))}
      {tipFor === detail.thread.id && (
        <FollowupsTip kind={shown[0]!.kind} name={shown[0]!.personName?.split(/\s+/)[0] || null} />
      )}
    </section>
  );
}
