import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import type { ScheduledInfo } from "@terno/core/rpc";
import { PopoverTrigger } from "@terno/ui/components/popover";
import { Clock, PenLine } from "@terno/ui/icons";
import { Button } from "@terno/ui/components/button";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAttachmentUploads } from "~/lib/attachments";
import { openStoredDraft } from "~/lib/compose";
import { authored, draftHomeThread, draftIndex, draftPresentationThread, shownDraftKey, useDrafts, type LocalDraft } from "~/lib/drafts";
import { useApp } from "~/state/app";
import { usePinned } from "~/lib/pinned-draft-state";
import { useSnack } from "~/lib/snack";
import { useList } from "~/state/list";
import { reminderShort, reminderWhen } from "~/lib/when";
import { firstInvalid } from "~/lib/recipient-field";
import { useScheduled } from "~/lib/scheduled";
import { ScheduledPopover } from "./scheduled-popover";

/** Who a draft goes to, for its one line. */
function recipientsLine(d: LocalDraft): string {
  const first = d.toText.split(",")[0]?.trim();
  if (!first) return t("compose.strip.none");
  const name = first.replace(/<.*$/, "").replace(/"/g, "").trim() || first.replace(/[<>]/g, "");
  const more = d.toText.split(",").length - 1;
  return t("compose.strip.to", { recipients: more > 0 ? t("compose.strip.andMore", { name, count: more }) : name });
}

/** Plan 94's "To …" line, from a scheduled send's addresses. */
function scheduledTo(s: ScheduledInfo): string {
  const first = s.to[0];
  if (!first) return "";
  const name = first.name || first.email;
  return s.to.length > 1 ? t("compose.strip.andMore", { name, count: s.to.length - 1 }) : name;
}

// on the rows' lines: the icon where their text starts, the hover shape where theirs is
const ROW = cn("relative flex h-9 min-w-0 flex-1 items-center gap-2 px-5 text-left text-sm", "before:absolute before:inset-x-2 before:inset-y-px before:rounded-md focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring");

/**
 * Plan 94: a scheduled send: its clock, what and to whom, and when it goes (in
 * the destructive ink while a try failed). A click opens Send later on it:
 * Send now, a new time, or Edit message.
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
              aria-label={t("sendLater.item", { recipients: recipients || t("compose.strip.none"), when: reminderWhen(s.sendAt) })}
              className={cn(ROW, open ? "before:bg-row-hover" : "hover:before:bg-row-hover")}
            />
          }
        >
          <Clock className="relative size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="relative min-w-0 shrink-0 truncate font-medium">{s.subject || t(s.mode === "new" ? "compose.untitled" : "common.noSubject")}</span>
          <span className="relative min-w-0 flex-1 truncate text-muted-foreground">{recipients ? t("compose.strip.to", { recipients }) : t("compose.strip.none")}</span>
          <span className={cn("relative shrink-0 text-xs tabular", s.error ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-scheduled-when">
            {reminderShort(s.sendAt)}
          </span>
        </PopoverTrigger>
      )}
    </ScheduledPopover>
  );
}

function DraftRow({ d }: { d: LocalDraft }) {
  // put away with an address that can't be one, it still says so: it won't send like that (plan 158)
  const invalid = firstInvalid(d.toText) ?? firstInvalid(d.ccText) ?? firstInvalid(d.bccText);
  return (
    <button type="button" data-testid="strip-item" data-key={d.key} onClick={() => void openStoredDraft(d.key)} className={cn(ROW, "hover:before:bg-row-hover")}>
      <PenLine className="relative size-3.5 shrink-0 text-muted-foreground" />
      <span className="relative min-w-0 shrink truncate font-medium">{d.subject || t(d.mode === "new" ? "compose.untitled" : "common.noSubject")}</span>
      <span className={cn("relative min-w-0 flex-1 truncate", invalid !== null ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-item-recipients">
        {invalid !== null ? t("compose.strip.invalid", { entry: invalid }) : recipientsLine(d)}
      </span>
    </button>
  );
}

/**
 * What's written but isn't on a row (plan 158): new messages, drafts whose
 * conversation isn't in this list (archived, moved, another view) and older
 * drafts of a conversation that has a newer one, plus scheduled sends. One
 * line at the foot of the list, level with the sidebar's foot, and a count
 * that opens the rest upward. Under the rows, so nothing it does moves one:
 * the list only gets shorter at its end. The new message being written isn't
 * here: it's on screen in the reader pane.
 */
export function DraftsStrip() {
  const compose = useApp((s) => s.compose?.key ?? null);
  const shown = useApp((s) => s.draftShown);
  const index = useList((s) => s.index);
  // plan 115: the pinned draft is on screen already
  const pinned = usePinned((s) => s.key);
  const [expanded, setExpanded] = useState(false);
  // the one Esc just came back from stays the one on the line, so focus has somewhere to land
  const [lead, setLead] = useState<string | null>(null);
  useEffect(() => { if (compose) setLead(compose); }, [compose]);
  const rootRef = useRef<HTMLDivElement>(null);
  // a file on its way counts as written: closing kept the draft, so Esc has its item to land on
  const uploads = useAttachmentUploads((s) => s);
  const items = useDrafts(
    useShallow((s) => {
      const out: LocalDraft[] = [];
      const drafts = draftIndex(s.drafts);
      for (const d of Object.values(s.drafts)) {
        if (d.key === pinned || d.key === compose || !(authored(d) || uploads.keys.has(d.key) || uploads.waiting.has(d.key))) continue;
        const home = draftHomeThread(d);
        if (home === null) { out.push(d); continue; }
        const placed = draftPresentationThread(d) !== null;
        const inline = index.has(home) && (placed ? shownDraftKey(s.drafts, home, shown) : drafts.home.get(home)?.key) === d.key;
        if (!inline) out.push(d);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }),
  );
  const scheduled = useScheduled((s) => s.items);
  const total = scheduled.length + items.length;
  // the dock stands on it, not over it
  useLayoutEffect(() => {
    useSnack.setState({ lift: rootRef.current?.offsetHeight ?? 0 });
    return () => useSnack.setState({ lift: 0 });
  }, [total, expanded]);
  if (total === 0) return null;
  const first = items.find((d) => d.key === lead) ?? (scheduled.length === 0 ? items[0] : undefined);
  const others = expanded ? { scheduled: first ? scheduled : scheduled.slice(1), items: items.filter((d) => d !== first) } : null;
  const more = total - 1;

  return (
    <div ref={rootRef} className="hairline-t hairline-strong shrink-0" data-testid="drafts-strip" role="group" aria-label={t("compose.strip.label")}>
      {others && (
        <div className="max-h-[40vh] overflow-y-auto hairline-b py-1" data-testid="strip-rest">
          {others.scheduled.map((s) => (
            <ScheduledRow key={s.draftId} s={s} />
          ))}
          {others.items.map((d) => (
            <DraftRow key={d.key} d={d} />
          ))}
        </div>
      )}
      <div className="flex items-center py-1 pr-4">
        {first ? <DraftRow d={first} /> : <ScheduledRow s={scheduled[0]!} />}
        {more > 0 && (
          <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground aria-expanded:text-foreground" data-testid="strip-more">
            {t("compose.strip.more", { count: more })}
          </Button>
        )}
      </div>
    </div>
  );
}
