import { personItemId, personItemThread, type PersonItem } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { CalendarClock, ChevronDown, Clock, ListChecks, MessageSquareReply } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useId, type ComponentType } from "react";
import { laterChoices, laterPresets, taskOf } from "~/lib/dated";
import { listDate } from "~/lib/format";
import { actOnPersonItem, openFromPerson } from "~/lib/people";
import { presetLabel, presetWhen } from "~/lib/reminders";
import { todaySentence, todayWhen } from "~/lib/today-sentence";

/** Plan 281: what an item is, in a glyph: your promise, their conversation waiting on you, a reply they owe you, their request. */
export function itemGlyph(item: PersonItem): ComponentType<{ className?: string }> {
  if (item.kind === "awaiting") return Clock;
  const kind = item.item.why.kind;
  return kind === "promise" ? ListChecks : kind === "waiting" ? MessageSquareReply : CalendarClock;
}

const ASKED = new Set(["ask", "respond"]);
const capital = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/**
 * An item in a few words, under its person's name (never naming them again): what kind of thing it is ("You promised",
 * "Waiting on you", "Owes you a reply", "Asked you") and what: the promise's words, the conversation's subject, the reply
 * you're owed, a request as What matters says it.
 */
export function itemParts(item: PersonItem): { label: string; text: string } {
  if (item.kind === "awaiting") return { label: t("people.kind.awaiting"), text: capital(item.row.text.trim() || item.thread.subject || t("common.noSubject")) };
  const { why, thread } = item.item;
  const subject = thread.subject?.trim() || t("common.noSubject");
  if (why.kind === "promise") return { label: t("people.kind.promise"), text: capital(why.text?.trim() || subject) };
  if (why.kind === "waiting") return { label: t("people.kind.waiting"), text: subject };
  return { label: t(why.item && ASKED.has(why.item.kind) ? "people.kind.asked" : "people.kind.todo"), text: todaySentence(item.item) };
}

/** An item as one line (the card's, a screen reader's): its kind and what. */
export const itemLine = (item: PersonItem): string => {
  const { label, text } = itemParts(item);
  return `${label}: ${text}`;
};

/** When, in the list's words: What matters' own column for its items (its tone, Missed's red); a reply owed, when you asked. */
export function itemWhen(item: PersonItem, now = Date.now()): { text: string | null; late: boolean } {
  if (item.kind === "awaiting") return { text: listDate(item.row.sentAt, now), late: false };
  const when = todayWhen(item.item, now);
  return { text: when.text, late: when.tone === "missed" };
}

/** Later's presets for an item: What matters' for its items (in their window), a reminder's for a reply owed to you. */
function presetsOf(item: PersonItem, now: number) {
  if (item.kind === "awaiting") return laterPresets({ before: null, limit: null }, now);
  const task = taskOf(item.item.why, now, item.item.thread);
  return task ? laterChoices(task, now) : [];
}

/**
 * One thing open between you, on a person's page: its sentence, the conversation it's in and when; Done and Later (a
 * reply owed to you: Done and Later too) on hover and focus, as What matters' items have them. The whole line opens its
 * conversation. `data-morph` names it for the act's morph (plan 251): it leaves, and the lines under it glide up.
 */
export function PersonItemLine({ item, morphName }: { item: PersonItem; morphName: string }) {
  const textId = useId();
  const Glyph = itemGlyph(item);
  const thread = personItemThread(item);
  const { label, text } = itemParts(item);
  const subject = thread.subject?.trim() || t("common.noSubject");
  const when = itemWhen(item);
  const now = Date.now();
  const presets = presetsOf(item, now);
  const actable = item.kind === "awaiting" || taskOf(item.item.why, now, item.item.thread) !== null;
  return (
    <li data-morph={morphName} data-testid="person-item" data-item={personItemId(item)} className="group/item relative rounded-lg hover:bg-row-hover">
      <button type="button" data-testid="person-item-open" onClick={() => openFromPerson(thread.id)} aria-describedby={textId} className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Glyph aria-hidden className="mt-[calc((1lh-1.15em)/2)] size-[1.15em] shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span id={textId} className="block text-base text-pretty text-foreground">
            {text}
          </span>
          <span className={cn("mt-0.5 flex min-w-0 items-baseline gap-3 text-sm", actable && "group-hover/item:pe-40 group-has-focus-reveal/item:pe-40 group-has-[[aria-expanded=true]]/item:pe-40")}>
            <span className="min-w-0 flex-1 truncate text-row-preview">
              <span className="font-medium">{label}</span>
              {text !== subject && <> · {subject}</>}
            </span>
            {when.text && <span className={cn("shrink-0 tabular", when.late ? "font-medium text-destructive-ink" : "text-row-preview")}>{when.text}</span>}
          </span>
        </span>
      </button>
      <span aria-hidden className="hairline-b pointer-events-none absolute start-3 end-3 -bottom-px group-hover/item:invisible" />
      {actable && (
        <div className="pointer-events-none absolute end-2 bottom-2 flex items-center gap-1 opacity-0 transition-opacity duration-fast group-hover/item:pointer-events-auto group-hover/item:opacity-100 has-focus-reveal:pointer-events-auto has-focus-reveal:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100">
          <Button variant="outline" size="xs" data-testid="person-item-done" aria-describedby={textId} className="focus-reveal:opacity-100" onClick={() => void actOnPersonItem(item, "done")}>
            {t("dated.done")}
          </Button>
          {presets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="xs" data-testid="person-item-later" aria-describedby={textId} className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground" />}>
                {t("dated.later")}
                <ChevronDown data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="w-max min-w-60" data-testid="person-item-later-menu">
                {presets.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => void actOnPersonItem(item, "later", p.at)}>
                    <span className="min-w-0 flex-1 truncate">{presetLabel(p.id)}</span>
                    <DropdownMenuShortcut className="tracking-normal tabular-nums">{presetWhen(p, now)}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </li>
  );
}
