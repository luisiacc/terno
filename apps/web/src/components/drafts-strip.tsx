import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import type { ScheduledInfo } from "@terno/core/rpc";
import { PopoverTrigger } from "@terno/ui/components/popover";
import { Clock, PenLine } from "@terno/ui/icons";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openStoredDraft } from "~/lib/compose";
import { draftPresentationThread, authored, shownDraftKey, useDrafts, type LocalDraft } from "~/lib/drafts";
import { useApp } from "~/state/app";
import { useList } from "~/state/list";
import { reminderShort, reminderWhen } from "~/lib/when";
import { useScheduled } from "~/lib/scheduled";
import { ScheduledPopover } from "./scheduled-popover";

const SHOWN = 3;

/** Who a draft goes to, for its one line. */
function recipientsLine(d: LocalDraft): string {
  const first = d.toText.split(",")[0]?.trim();
  if (!first) return t("compose.strip.noRecipients");
  const name = first.replace(/<.*$/, "").replace(/"/g, "").trim() || first.replace(/[<>]/g, "");
  const more = d.toText.split(",").length - 1;
  return more > 0 ? t("compose.strip.andMore", { name, count: more }) : name;
}

/** Plan 94's "To …" line, from a scheduled send's addresses. */
function scheduledTo(s: ScheduledInfo): string {
  const first = s.to[0];
  if (!first) return t("compose.strip.noRecipients");
  const name = first.name || first.email;
  return s.to.length > 1 ? t("compose.strip.andMore", { name, count: s.to.length - 1 }) : name;
}

const ROW = cn("relative flex h-9 w-full items-center gap-2 px-5 text-left text-sm", "before:absolute before:inset-x-2 before:inset-y-px before:rounded-md");

/**
 * Plan 94: a scheduled send, above the drafts: its clock, what and to whom,
 * and when it goes (in the destructive ink while a try failed). A click opens
 * Send later on it: Send now, a new time, or Edit message.
 */
function ScheduledRow({ s }: { s: ScheduledInfo }) {
  const recipients = scheduledTo(s);
  return (
    <ScheduledPopover s={s} align="start">
      {(open) => (
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="strip-scheduled"
              data-draft-id={s.draftId}
              aria-label={t("sendLater.item", { recipients, when: reminderWhen(s.sendAt) })}
              className={cn(ROW, open ? "before:bg-row-hover" : "hover:before:bg-row-hover")}
            />
          }
        >
          <Clock className="relative size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="relative min-w-0 shrink-0 truncate font-medium">{s.subject || t(s.mode === "new" ? "compose.untitled" : "common.noSubject")}</span>
          <span className="relative min-w-0 flex-1 truncate text-muted-foreground">{t("compose.strip.to", { recipients })}</span>
          <span className={cn("relative shrink-0 text-xs tabular", s.error ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-scheduled-when">
            {reminderShort(s.sendAt)}
          </span>
        </PopoverTrigger>
      )}
    </ScheduledPopover>
  );
}

/**
 * Drafts that aren't on screen otherwise, above the list (outside the
 * virtualizer, where the banners sit): new messages, drafts whose
 * conversation isn't in this list (archived, moved, another view) and older
 * drafts of a conversation that has a newer one. One click away each.
 * Scheduled sends (plan 94) come first.
 */
export function DraftsStrip() {
  const compose = useApp((s) => s.compose?.key ?? null);
  const shown = useApp((s) => s.draftShown);
  const index = useList((s) => s.index);
  const [expanded, setExpanded] = useState(false);
  const items = useDrafts(
    useShallow((s) => {
      const out: LocalDraft[] = [];
      for (const d of Object.values(s.drafts)) {
        const thread = draftPresentationThread(d);
        if (thread === null) {
          if (authored(d) || d.key === compose) out.push(d);
        } else if (authored(d)) {
          const inline = index.has(thread) && shownDraftKey(s.drafts, thread, shown) === d.key;
          if (!inline) out.push(d);
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }),
  );
  const scheduled = useScheduled((s) => s.items);
  const total = scheduled.length + items.length;
  if (total === 0) return null;
  const shownScheduled = expanded ? scheduled : scheduled.slice(0, SHOWN);
  const visible = expanded ? items : items.slice(0, Math.max(0, SHOWN - shownScheduled.length));

  return (
    <div className="hairline-b shrink-0 py-1" data-testid="drafts-strip" role="group" aria-label={t("compose.strip.label")}>
      {shownScheduled.map((s) => (
        <ScheduledRow key={s.draftId} s={s} />
      ))}
      {visible.map((d) => (
        <button
          key={d.key}
          type="button"
          data-testid="strip-item"
          data-key={d.key}
          aria-current={compose === d.key || undefined}
          onClick={() => void openStoredDraft(d.key)}
          className={cn(
            ROW,
            compose === d.key ? "text-row-selected-foreground before:bg-row-selected" : "hover:before:bg-row-hover",
          )}
        >
          <PenLine className="relative size-3.5 shrink-0 text-primary" />
          <span className="relative min-w-0 shrink-0 truncate font-medium">{d.subject || t(d.mode === "new" ? "compose.untitled" : "common.noSubject")}</span>
          <span className="relative min-w-0 truncate text-muted-foreground">{t("compose.strip.to", { recipients: recipientsLine(d) })}</span>
        </button>
      ))}
      {!expanded && total > SHOWN && (
        <button type="button" onClick={() => setExpanded(true)} className="h-7 w-full px-5 text-left text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="strip-more">
          {t("compose.strip.more", { count: total - SHOWN })}
        </button>
      )}
    </div>
  );
}
