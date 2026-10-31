import { defaultRemindAt, remindPresets, type ReminderKind } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { cn } from "@terno/ui/lib/utils";
import { BellOff, CalendarClock } from "lucide-react";
import { useId, useRef, useState } from "react";
import { clearReminder, presetLabel, reminderShort, reminderWhen, setReminder, useReminders } from "~/lib/reminders";

const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** the inputs' local date and time, as a moment (null: incomplete) */
function moment(date: string, time: string): number | null {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  if (!y || !m || !d || h === undefined || min === undefined || Number.isNaN(h) || Number.isNaN(min)) return null;
  return new Date(y, m - 1, d, h, min).getTime();
}

/**
 * Plan 87's picker: Remind me or If no reply, its presets with their
 * moments, a date and time of your own, and the reminder there is now (with
 * Clear). The reader's bell opens it in a popover; the menu's "Pick date &
 * time…" and h (without a reader) in a dialog. Arrow keys move through the
 * choices; `done` closes whatever holds it.
 */
export function RemindPicker({ threadIds, initialKind, custom = false, done }: { threadIds: readonly number[]; initialKind?: ReminderKind; custom?: boolean; done: () => void }) {
  const current = useReminders((s) => (threadIds.length === 1 ? s.byThread.get(threadIds[0]!) : undefined));
  // the kind asked for ("Remind me if no reply ▸ Pick…") wins; else the reminder there is; else Remind me
  const [kind, setKind] = useState<ReminderKind>(initialKind ?? current?.kind ?? "always");
  const [picking, setPicking] = useState(custom);
  const start = new Date(defaultRemindAt(new Date()));
  const [date, setDate] = useState(dateValue(start));
  const [time, setTime] = useState(timeValue(start));
  const listRef = useRef<HTMLDivElement>(null);
  const pastId = useId();
  const presets = remindPresets(new Date(), kind);
  const at = moment(date, time);
  const past = at !== null && at <= Date.now();

  const set = (dueAt: number) => {
    done();
    void setReminder(threadIds, dueAt, kind);
  };
  // ↑/↓ between the choices (the segmented control keeps its own ←/→)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-remind-choice]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const choice = "flex h-8 w-full items-center gap-3 rounded-md px-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";
  return (
    <div className="flex flex-col gap-2" data-testid="remind-picker" onKeyDown={onKeyDown}>
      {current && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="remind-current">
          {t(current.kind === "noReply" ? "remind.currentNoReply" : "remind.current", { when: reminderWhen(current.dueAt) })}
        </p>
      )}
      <ToggleGroup
        aria-label={t("remind.kind.label")}
        value={[kind]}
        onValueChange={(v: string[]) => v[0] && setKind(v[0] as ReminderKind)}
        spacing={0}
        className="flex w-full rounded-lg bg-muted p-0.5"
        data-testid="remind-kind"
      >
        {(["always", "noReply"] as const).map((k) => (
          <ToggleGroupItem
            key={k}
            value={k}
            data-testid={`remind-kind-${k}`}
            className="h-7 flex-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm"
          >
            {t(k === "noReply" ? "remind.kind.noReply" : "remind.kind.always")}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div ref={listRef} className="-mx-1 flex flex-col" role="group" aria-label={t("remind.title")}>
        {presets.map((p) => (
          <button key={p.id} type="button" data-remind-choice data-testid={`remind-preset-${p.id}`} className={choice} onClick={() => set(p.at)}>
            <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular">{reminderShort(p.at)}</span>
          </button>
        ))}
        <button type="button" data-remind-choice data-testid="remind-pick" aria-expanded={picking} className={choice} onClick={() => setPicking((v) => !v)}>
          <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("remind.pick")}</span>
        </button>
        {picking && (
          <form
            className="flex flex-col gap-2 px-2 pt-1 pb-1"
            data-testid="remind-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (at !== null && !past) set(at);
            }}
          >
            <div className="flex gap-2">
              <Input type="date" aria-label={t("remind.date")} data-testid="remind-date" value={date} min={dateValue(new Date())} onChange={(e) => setDate(e.target.value)} aria-invalid={past || undefined} aria-describedby={past ? pastId : undefined} className="h-8 flex-1" />
              <Input type="time" aria-label={t("remind.time")} data-testid="remind-time" value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={past || undefined} aria-describedby={past ? pastId : undefined} className="h-8 w-28" />
            </div>
            {past && (
              <p id={pastId} className="text-xs text-destructive-ink" data-testid="remind-past">
                {t("remind.past")}
              </p>
            )}
            <Button type="submit" size="sm" data-testid="remind-set" disabled={at === null || past} className="self-end">
              {t("remind.set")}
            </Button>
          </form>
        )}
        {current && (
          <>
            <div className="my-1 h-(--hairline-w) bg-hairline" aria-hidden />
            <button
              type="button"
              data-remind-choice
              data-testid="remind-clear"
              className={cn(choice)}
              onClick={() => {
                done();
                void clearReminder(threadIds);
              }}
            >
              <BellOff className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("remind.clear")}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
