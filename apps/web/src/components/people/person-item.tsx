import { isPersonRequest, personItemAhead, personItemBack, personItemId, personItemThread, type PersonItem } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { CalendarClock, Check, ChevronDown, Clock, ListChecks, MessageSquareReply } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useId, type ComponentType } from "react";
import { shortcutFor } from "@terno/core";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { laterChoices, laterPresets, taskOf } from "~/lib/dated";
import { listDate } from "~/lib/format";
import { actOnCardItem, actOnPersonItem, openFromPerson, pickPersonLater } from "~/lib/people";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { todaySentence, todayWhen } from "~/lib/today-sentence";

/** Done and Later: quiet, the control itself brought up under the pointer or open */
const QUIET = "text-muted-foreground hover:text-foreground aria-expanded:text-foreground";

/**
 * Done and Later show on the line's hover only (the owner, after rating round 7), or while the keyboard is on the line or
 * Later's menu is open: never a row of buttons down the page at rest.
 */
export const ON_HOVER = "opacity-0 transition-opacity duration-fast ease-motion group-hover/item:opacity-100 group-focus-within/item:opacity-100 has-[[aria-expanded=true]]:opacity-100";

/** What matters' own keys for Done and Later, on the item the keyboard is on (plan 281) */
const DONE_KEY = shortcutFor("today.done") ?? "d";
const LATER_KEY = shortcutFor("today.later") ?? "b";

/** Plan 281: what an item is, in a glyph: your promise, their conversation waiting on you, a reply they owe you, their request. */
export function itemGlyph(item: PersonItem): ComponentType<{ className?: string }> {
  if (item.kind === "awaiting") return Clock;
  const kind = item.item.why.kind;
  return kind === "promise" ? ListChecks : kind === "waiting" ? MessageSquareReply : CalendarClock;
}

/**
 * The glyph's ink (owner, after the QA panel): the two kinds a row's words alone wouldn't set apart are tinted, your
 * promise in the unread's ink, a reply owed to you in the success ink (both 3:1 on every surface they're drawn on,
 * `CONTRAST_PAIRS`); the rest stay muted.
 */
export function itemTone(item: PersonItem): string {
  if (item.kind === "awaiting") return "text-success-ink";
  return item.item.why.kind === "promise" ? "text-unread" : "text-muted-foreground";
}

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/**
 * An item in a few words, under its person's name (never naming them again): what kind of thing it is ("You promised",
 * "Waiting on you", "Owes you a reply", "Asked you") and what: the promise's words, the conversation's subject, the reply
 * you're owed, a request as What matters says it. Every kind in words (the owner, after rating round 4: a glyph alone
 * didn't say it); the glyph's tint sets the promise and the reply owed apart.
 */
export function itemParts(item: PersonItem): { label: string; text: string } {
  if (item.kind === "awaiting") return { label: t("people.kind.awaiting"), text: capital(item.row.text.trim() || item.thread.subject || t("common.noSubject")) };
  const { why, thread } = item.item;
  const subject = thread.subject?.trim() || t("common.noSubject");
  if (why.kind === "promise") return { label: t("people.kind.promise"), text: capital(why.text?.trim() || subject) };
  if (why.kind === "waiting") return { label: t("people.kind.waiting"), text: subject };
  return { label: t(isPersonRequest(why.item?.kind) ? "people.kind.asked" : "people.kind.todo"), text: todaySentence(item.item) };
}

const DAY = 86_400_000;

/**
 * How long it's been open (Open's order, longest waiting first: the row says it): today, then days, weeks, months. `said`,
 * the same for a screen reader ("Open for 3 days").
 */
export function waited(since: number, now = Date.now()): { text: string; said: string } {
  // by the calendar: yesterday at 4 PM is a day ago at noon (Codex review)
  const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(since)) / DAY);
  if (days < 1) return { text: t("people.age.today"), said: t("people.ageSaidToday") };
  const text = days < 14 ? t("people.age.days", { count: days }) : days < 60 ? t("people.age.weeks", { count: Math.floor(days / 7) }) : t("people.age.months", { count: Math.floor(days / 30) });
  return { text, said: t("people.ageSaid", { age: text }) };
}

/**
 * When, in the list's words: What matters' own column for its items (its tone, Missed's red); a reply owed, when you'll
 * follow up (its Later moves that, as in Follow-ups), else when you asked; one put off with Later, when it's back. `later`:
 * not open yet (put off, or behind What matters' Coming up: owner, 2026-11-26), drawn quieter, under the page's Later.
 */
export function itemWhen(item: PersonItem, now = Date.now()): { text: string | null; late: boolean; later: boolean } {
  const back = personItemBack(item, now);
  if (back !== null) return { text: t("people.backOn", { when: listDate(back, now) }), late: false, later: true };
  if (item.kind === "awaiting")
    return { text: item.row.dueAt > now ? t("people.followUpOn", { when: listDate(item.row.dueAt, now) }) : t("people.askedOn", { when: listDate(item.row.sentAt, now) }), late: false, later: false };
  const when = todayWhen(item.item, now);
  return { text: when.text, late: when.tone === "missed", later: personItemAhead(item, now) !== null };
}

/**
 * One thing open between you, on a person's page: what it is, then its kind, the conversation it's in and when, on one
 * quiet line (as the card says it); Done and Later at its end, always there (this page is for acting on these), quiet
 * until the line is hovered or has the keyboard. The line opens its conversation. `data-morph` names it for the act's
 * morph (plan 251): it leaves, and the lines under it glide up. One put off with Later reads quieter, with when it's back.
 */
export function PersonItemLine({ item, morphName }: { item: PersonItem; morphName: string }) {
  const textId = useId();
  const Glyph = itemGlyph(item);
  const thread = personItemThread(item);
  const parts = itemParts(item);
  const { text } = parts;
  const subject = thread.subject?.trim() || t("common.noSubject");
  const when = itemWhen(item);
  const now = Date.now();
  const task = item.kind === "today" ? taskOf(item.item.why, now, item.item.thread) : null;
  const presets = personLaterPresets(item, now);
  const actable = item.kind === "awaiting" || task !== null;
  return (
    <li data-morph={morphName} data-testid="person-item" data-item={personItemId(item)} data-later={when.later || undefined} className="group/item relative flex items-center gap-2 rounded-lg pe-2 hover:bg-row-hover">
      <button type="button" data-testid="person-item-open" data-place={`item:${personItemId(item)}`} onClick={() => openFromPerson(thread.id)} className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Glyph aria-hidden className={cn("mt-[calc((1lh-1.15em)/2)] size-[1.15em] shrink-0", itemTone(item))} />
        <span className="min-w-0 flex-1">
          <span id={textId} className={cn("block text-base text-pretty", when.later ? "text-foreground-soft" : "text-foreground")}>
            {text}
          </span>
          {/* (its when is never what a long subject cuts) */}
          <span className="mt-0.5 flex min-w-0 text-sm whitespace-pre text-row-preview">
            <span className="min-w-0 truncate">
              <span className="font-medium">{parts.label}</span>
              {text !== subject && <> · {subject}</>}
            </span>
            {when.text && (
              <span className="shrink-0">
                {" · "}
                <span className={cn("tabular", when.late && "font-medium text-destructive-ink")}>{when.text}</span>
              </span>
            )}
          </span>
        </span>
      </button>
      <span aria-hidden className="hairline-b pointer-events-none absolute start-3 end-3 -bottom-px group-hover/item:invisible" />
      {actable && (
        <div data-testid="person-item-actions" className={cn("flex shrink-0 items-center gap-1", ON_HOVER)}>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="sm" data-testid="person-item-done" aria-describedby={textId} aria-keyshortcuts={DONE_KEY} className={QUIET} onClick={(e) => void actOnPersonItem(item, "done", undefined, e.detail > 0 ? "pointer" : "keyboard")} />}>
              <Check data-icon="inline-start" />
              {t("dated.done")}
            </TooltipTrigger>
            <TooltipContent>
              {t("dated.done")} <Shortcut keys={DONE_KEY} />
            </TooltipContent>
          </Tooltip>
          {actable && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={<DropdownMenuTrigger render={<Button variant="ghost" size="sm" data-testid="person-item-later" aria-describedby={textId} aria-keyshortcuts={LATER_KEY} className={QUIET} />} />}
                >
                  <Clock data-icon="inline-start" />
                  {t("dated.later")}
                  <ChevronDown data-icon="inline-end" />
                </TooltipTrigger>
                <TooltipContent>
                  {t("dated.later")} <Shortcut keys={LATER_KEY} />
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" sideOffset={4} className="w-max min-w-60" data-testid="person-item-later-menu">
                <LaterChoices item={item} presets={presets} now={now} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </li>
  );
}

/** An item's Later moments now: a reply owed to you, anywhere ahead; one of What matters', in its window. */
export function personLaterPresets(item: PersonItem, now: number) {
  if (item.kind === "awaiting") return laterPresets({ before: null, limit: null }, now);
  const task = taskOf(item.item.why, now, item.item.thread);
  return task ? laterChoices(task, now) : [];
}

/**
 * Later's presets in its window, then a moment of your own (What matters' own picker, `PersonLaterDialog`): the page's menu
 * and the card's submenu.
 */
export function LaterChoices({ item, presets, now, via = "page", testPrefix = "person-item-later" }: { item: PersonItem; presets: ReturnType<typeof personLaterPresets>; now: number; via?: "page" | "card"; testPrefix?: string }) {
  const later = (at: number) => void (via === "card" ? actOnCardItem(item, "later", at) : actOnPersonItem(item, "later", at));
  return (
    <>
      {presets.map((p) => (
        <DropdownMenuItem key={p.id} data-testid={`${testPrefix}-${p.id}`} onClick={() => later(p.at)}>
          <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
          <DropdownMenuShortcut className="tracking-normal tabular-nums">{presetWhen(p, now)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
      {presets.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem data-testid={`${testPrefix}-pick`} onClick={() => pickPersonLater(item, via)}>
        <CalendarClock />
        <span className="min-w-0 flex-1 truncate">{t("dated.pickDate")}</span>
      </DropdownMenuItem>
    </>
  );
}
