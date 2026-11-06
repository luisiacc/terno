import { remindPresets, type FollowupRow, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight } from "@terno/ui/icons";
import { lazy, Suspense, useEffect } from "react";
import { actOnFollowup, followupLine } from "~/lib/followups";
import { presetLabel, reminderShort } from "~/lib/reminders";
import { revealSummaryMessage } from "~/lib/summaries";
import { nudge } from "~/lib/followup-nudge";
import { offerTip, usePendingTip } from "~/lib/tips";
import { useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";

const FollowupsTip = lazy(() => import("./followups-tip"));

function Line({ row }: { row: FollowupRow }) {
  const line = followupLine(row);
  const later = remindPresets(new Date(), "always");
  return (
    <div className="space-y-1" data-testid="followup-line" data-kind={row.kind} data-state={row.state}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="followup-go"
              onClick={() => revealSummaryMessage(row.messageId)}
              className="group/item -mx-2 flex min-h-7 w-[calc(100%+1rem)] items-baseline gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-tint focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          }
        >
          <span className="min-w-0 flex-1" data-testid="followup-text">{line}</span>
          <span className="sr-only">{t("summary.goTo")}</span>
          <span aria-hidden className="flex h-[1lh] shrink-0 items-center self-start">
            <ArrowRight className="size-[1.15em] text-muted-foreground transition-colors group-hover/item:text-foreground" />
          </span>
        </TooltipTrigger>
        {row.quote && <TooltipContent data-testid="followup-quote">{row.quote}</TooltipContent>}
      </Tooltip>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {/* when it comes back: a promise's line need not say, and Later moves it */}
        <span data-testid="followup-due" className="tabular">{t(row.state === "due" ? "followup.dueNow" : "followup.dueOn", { date: reminderShort(row.dueAt) })}</span>
        <span aria-hidden>·</span>
        {row.kind === "awaiting" ? (
          <>
            <Button variant="link-secondary" size="xs" data-testid="followup-nudge" onClick={() => void nudge(row)}>{t("followup.nudge")}</Button>
            <span aria-hidden>·</span>
            <Button variant="link-secondary" size="xs" data-testid="followup-dismiss" onClick={() => void actOnFollowup(row, "dismiss")}>{t("followup.dismiss")}</Button>
          </>
        ) : (
          <>
            <Button variant="link-secondary" size="xs" data-testid="followup-done" onClick={() => void actOnFollowup(row, "done")}>{t("followup.done")}</Button>
            <span aria-hidden>·</span>
            <Button variant="link-secondary" size="xs" data-testid="followup-dismiss" onClick={() => void actOnFollowup(row, "dismiss")}>{t("followup.notPromise")}</Button>
          </>
        )}
        <span aria-hidden>·</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="link-secondary" size="xs" data-testid="followup-later" />}>{t("followup.later")}</DropdownMenuTrigger>
          <DropdownMenuContent>
            {later.map((p) => (
              <DropdownMenuItem key={p.id} data-testid={`followup-later-${p.id}`} onClick={() => void actOnFollowup(row, "later", p.at)}>{presetLabel(p.id)}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Plan 142 §7: a quiet line for each thing this conversation holds, in the conversation's text column, above its summary. */
export default function ThreadFollowups({ detail }: { detail: ThreadDetail }) {
  const enabled = useApp((s) => s.settings?.followups?.enabled === true);
  const rows = useFollowups((s) => s.byThread.get(detail.thread.id));
  const shown = enabled && !detail.thread.inTrash && !detail.thread.inSpam ? rows : undefined;
  const tipFor = usePendingTip("followups-first");
  const fresh = shown?.some((r) => !r.fromScan);
  useEffect(() => {
    if (fresh) offerTip("followups-first", detail.thread.id);
  }, [fresh, detail.thread.id]);
  if (!shown?.length) return null;
  return (
    <section className="mb-3 space-y-2 border-b border-hairline pb-3" aria-label={t("followups.title")} data-testid="thread-followups">
      {shown.map((row) => (
        <Line key={row.id} row={row} />
      ))}
      {tipFor === detail.thread.id && (
        <Suspense fallback={null}>
          <FollowupsTip />
        </Suspense>
      )}
    </section>
  );
}
