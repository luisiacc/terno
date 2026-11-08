import { remindPresets, type FollowupRow, type MessageDetail, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, ChevronDown, Clock } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect } from "react";
import { followupsOffered } from "~/lib/ai";
import { useCanDraft } from "~/lib/ai-draft-state";
import { actOnFollowup, followupLine, followupWhen } from "~/lib/followups";
import { useDrafts } from "~/lib/drafts";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { revealSummaryMessage } from "~/lib/summaries";
import { nudge, nudgeDraft, openNudge } from "~/lib/followup-nudge";
import { offerTip, usePendingTip } from "~/lib/tips";
import { useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { AI_ACTIONS, AI_GLYPH, AI_HEADER, AI_TITLE, messageSource } from "./ai-card";
import FollowupsTip from "./followups-tip";

/**
 * Plan 161: the line in the AI suggestions' anatomy, without their card (plan 148: it's the user's own to act on): a header
 * saying when it comes back, the line, and a row of buttons, its source last. Pass 2: each thing said once, with a date,
 * and the source named, or not offered on a conversation that is the one message on screen.
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
  // the nudge Draft a nudge made, still a draft: the line offers it rather than another
  const drafted = useDrafts((s) => (awaiting ? nudgeDraft(row.threadId, s.drafts) !== null : false));
  return (
    <div data-testid="followup-line" data-kind={row.kind} data-state={row.state}>
      <p data-testid="followup-header" className={cn(AI_HEADER, "min-h-0 pt-0 pb-1")}>
        <Clock aria-hidden className={AI_GLYPH} />
        <span className={AI_TITLE}>{t("followup.header")}</span>
        <span aria-hidden>·</span>
        <span data-testid="followup-due" className="min-w-0 tabular">{followupWhen(row)}</span>
      </p>
      <p className="text-sm" data-testid="followup-text">{line}</p>
      <div className={cn(AI_ACTIONS, "mt-2")} data-testid="followup-actions">
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
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" data-testid="followup-later" />}>
            {t("followup.later")}
            <ChevronDown aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {later.map((p) => (
              // the moment each one resolves to, at the row's end, as Remind me shows its own (plan 161, pass 2)
              <DropdownMenuItem key={p.id} data-testid={`followup-later-${p.id}`} onClick={() => void actOnFollowup(row, "later", p.at)}>
                <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
                <span data-testid="followup-later-when" className="ms-4 shrink-0 text-xs text-muted-foreground tabular">{presetWhen(p, now.getTime())}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" data-testid="followup-dismiss" onClick={() => void actOnFollowup(row, "dismiss")}>{t(awaiting ? "followup.dismiss" : "followup.notPromise")}</Button>
        {/* where it came from: whose and when, not a bare arrow, and its words (the quote) on hover; nothing when it's the
            one message on screen */}
        {source !== null && (
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="sm" data-testid="followup-go" className="ms-auto -me-2.5 text-muted-foreground" onClick={() => revealSummaryMessage(row.messageId)} />}
            >
              {source}
              <ArrowRight aria-hidden />
            </TooltipTrigger>
            {row.quote && <TooltipContent data-testid="followup-quote">{row.quote}</TooltipContent>}
          </Tooltip>
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
    <section className="mb-4 space-y-4" aria-label={t("followups.title")} data-testid="thread-followups">
      {shown.map((row) => (
        <Line key={row.id} row={row} messages={detail.messages} />
      ))}
      {tipFor === detail.thread.id && (
        <FollowupsTip kind={shown[0]!.kind} name={shown[0]!.personName?.split(/\s+/)[0] || null} />
      )}
    </section>
  );
}
