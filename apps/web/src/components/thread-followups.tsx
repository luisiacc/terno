import { remindPresets, type FollowupRow, type MessageDetail, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, ChevronDown, Clock } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect } from "react";
import { followupsOffered, modelName } from "~/lib/ai";
import { fullDate } from "~/lib/format";
import { useCanDraft } from "~/lib/ai-draft-state";
import { actOnFollowup, followupLine, followupWhen } from "~/lib/followups";
import { useDrafts } from "~/lib/drafts";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { revealSummaryMessage } from "~/lib/summaries";
import { nudge, nudgeDraft, openNudge } from "~/lib/followup-nudge";
import { offerTip, usePendingTip } from "~/lib/tips";
import { useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { AI_ACTIONS, AI_CARD, AI_GLYPH, AI_HEADER, AI_TITLE, AiProvenance, messageSource } from "./ai-card";
import FollowupsTip from "./followups-tip";

/**
 * Plan 161: the line in the AI suggestions' anatomy. Pass 3: on their card too, as Reply ready is (plan 148 left a card out
 * of its scope; raters read the bare line as mail metadata): the fact is the title ("Arjun hasn't replied yet"), when it
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
          drafted ? (
            <Button size="sm" data-testid="followup-open-nudge" onClick={() => void openNudge(row.threadId)}>{t("followup.openNudge")}</Button>
          ) : (
            canNudge && <Button size="sm" data-testid="followup-nudge" onClick={() => void nudge(row)}>{t("followup.nudge")}</Button>
          )
        ) : (
          <Button size="sm" data-testid="followup-done" onClick={() => void actOnFollowup(row, "done")}>{t("followup.done")}</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="text-foreground" data-testid="followup-later" />}>
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
          </DropdownMenuContent>
        </DropdownMenu>
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
            detail={t("ai.provenance.foundDetail", { model: modelName(row.model), date: fullDate(row.createdAt) })}
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
