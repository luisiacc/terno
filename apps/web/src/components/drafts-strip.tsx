import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import type { ScheduledInfo } from "@terno/core/rpc";
import { PopoverTrigger } from "@terno/ui/components/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { ChevronDown, Clock, PenLine } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAttachmentUploads } from "~/lib/attachments";
import { composeIntent, focusDraftOnScreen, openStoredDraft } from "~/lib/compose";
import { pinnedKey } from "~/lib/pinned-draft-state";
import { getApp, getSelectionWriteRevision } from "~/state/app";
import { authored, useDrafts, type LocalDraft } from "~/lib/drafts";
import { reminderShort, reminderWhen } from "~/lib/when";
import { firstInvalid } from "~/lib/recipient-field";
import { useScheduled } from "~/lib/scheduled";
import { ScheduledPopover } from "./scheduled-popover";

/** What a draft's line shows, and nothing else: typing in its body renders no line. */
interface DraftLine {
  subject: string;
  mode: string;
  toText: string;
  invalid: string | null;
}

function useDraftLine(key: string): DraftLine | null {
  return useDrafts(
    useShallow((s) => {
      const d = s.drafts[key];
      if (!d) return null;
      // put away with an address that can't be one, it still says so: it won't send like that (plan 158)
      return { subject: d.subject, mode: d.mode, toText: d.toText, invalid: firstInvalid(d.toText) ?? firstInvalid(d.ccText) ?? firstInvalid(d.bccText) };
    }),
  );
}

/** A draft's first recipient as its line names them (the name, else the address), or "" with none. */
function firstRecipient(toText: string): string {
  const comma = toText.indexOf(",");
  const first = (comma < 0 ? toText : toText.slice(0, comma)).trim();
  return first && (first.replace(/<.*$/, "").replace(/"/g, "").trim() || first.replace(/[<>]/g, ""));
}

/** Who a draft goes to, for its one line. */
function recipientsLine(toText: string): string {
  const name = firstRecipient(toText);
  if (!name) return t("compose.strip.none");
  const more = toText.split(",").length - 1;
  return t("compose.strip.to", { recipients: more > 0 ? t("compose.strip.andMore", { name, count: more }) : name });
}

/** Plan 94's "To …" line, from a scheduled send's addresses. */
function scheduledTo(s: ScheduledInfo): string {
  const first = s.to[0];
  if (!first) return "";
  const name = first.name || first.email;
  return s.to.length > 1 ? t("compose.strip.andMore", { name, count: s.to.length - 1 }) : name;
}

const draftSubject = (d: DraftLine) => d.subject || t(d.mode === "new" ? "compose.untitled" : "common.noSubject");
const scheduledSubject = (s: ScheduledInfo) => s.subject || t(s.mode === "new" ? "compose.untitled" : "common.noSubject");

type Uploads = { keys: Set<string>; waiting: Set<string> };
/**
 * Plan 175: every draft with the user's words in it, wherever it is (on a row, open, pinned, put away). A file on its
 * way counts as written: closing kept the draft, so Esc has its item to land on. A send in flight stays until it's
 * sent: it can be opened again (never sent twice, plan 158).
 */
const counted = (d: LocalDraft, uploads: Uploads) => authored(d) || uploads.keys.has(d.key) || uploads.waiting.has(d.key);

/** How many, and which when there's one: all the closed row needs, so typing in a draft (its body, its order) renders nothing here. */
function useDraftCount(): string | number {
  const uploads = useAttachmentUploads((s) => s);
  return useDrafts((s) => {
    let n = 0, only = "";
    for (const d of Object.values(s.drafts)) if (counted(d, uploads)) { n++; only = d.key; }
    return n === 1 ? only : n;
  });
}

/** The open dropdown's drafts, newest first (of two from the same moment, the one begun later): only it follows their order. */
function useDraftKeys(): string[] {
  const uploads = useAttachmentUploads((s) => s);
  return useDrafts(
    useShallow((s) =>
      Object.values(s.drafts)
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => counted(d, uploads))
        .sort((a, b) => b.d.updatedAt - a.d.updatedAt || b.i - a.i)
        .map(({ d }) => d.key),
    ),
  );
}

// more than one line holds: the rest would only be cut off
const PEOPLE_SHOWN = 8;

// a draft's first recipient, kept for as long as the draft is unchanged: a keystroke reads one draft's anew
const firstOf = new WeakMap<LocalDraft, string>();
const firstOfDraft = (d: LocalDraft): string => {
  let name = firstOf.get(d);
  if (name === undefined) firstOf.set(d, (name = firstRecipient(d.toText)));
  return name;
};

/**
 * Who the several drafts go to, for the row that counts them: each one's first recipient, newest draft first, each
 * person once. One pass, no sort, on every change to the drafts; typing renders nothing unless it changes who's first.
 */
function useDraftPeople(): string[] {
  const uploads = useAttachmentUploads((s) => s);
  return useDrafts(
    useShallow((s) => {
      // each person's newest draft (of two from the same moment, the one begun later)
      const newest = new Map<string, { at: number; i: number }>();
      let i = 0;
      for (const d of Object.values(s.drafts)) {
        i++;
        if (d.toText === "" || !counted(d, uploads)) continue;
        const name = firstOfDraft(d);
        const was = name ? newest.get(name) : undefined;
        if (name && (!was || d.updatedAt > was.at || (d.updatedAt === was.at && i > was.i))) newest.set(name, { at: d.updatedAt, i });
      }
      return [...newest].sort(([, a], [, b]) => b.at - a.at || b.i - a.i).slice(0, PEOPLE_SHOWN).map(([name]) => name);
    }),
  );
}

/**
 * Focus in a part of the row that gives way to another (one draft becomes several, a menu or Send later goes with its
 * row): `handOver` says so, and the row that replaces it takes focus. Read before the part leaves the page.
 */
function useHandsOver(ref: React.RefObject<HTMLElement | null>, handOver: React.RefObject<boolean>) {
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    if (active && (ref.current?.contains(active) || active.closest("[data-testid=strip-menu], [data-testid=scheduled-popover]"))) handOver.current = true;
  }, []);
}

/** A draft from the drafts row: focused where it is if it's open on screen, else opened as stored work. */
const openFromRow = async (key: string): Promise<void> => { if (!focusDraftOnScreen(key)) await openStoredDraft(key); };

// on the rows' lines: the icon where their text starts, the hover shape where theirs is
const ROW = cn("relative flex h-9 min-w-0 flex-1 items-center gap-2 px-5 text-left text-sm", "before:absolute before:inset-x-2 before:inset-y-px before:rounded-md focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring");

/** The one draft: the row is it, said as a row says it, the pen and a Draft tag in the draft ink (plan 158). */
function DraftRow({ draftKey, handOver }: { draftKey: string; handOver: React.RefObject<boolean> }) {
  const ref = useRef<HTMLButtonElement>(null);
  useHandsOver(ref, handOver);
  const d = useDraftLine(draftKey);
  if (!d) return null;
  return (
    <button ref={ref} type="button" data-testid="strip-item" data-key={draftKey} onClick={() => void openFromRow(draftKey)} className={cn(ROW, "hover:before:bg-row-hover")}>
      <PenLine className="relative size-3.5 shrink-0 text-draft-foreground" />
      <span className="relative min-w-0 shrink truncate font-medium">{draftSubject(d)}</span>
      <span aria-hidden data-testid="strip-item-tag" className="relative shrink-0 text-xs leading-none font-medium text-draft-foreground">{t("list.draft")}</span>
      <span className={cn("relative min-w-0 flex-1 truncate", d.invalid !== null ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-item-recipients">
        {d.invalid !== null ? t("compose.strip.invalid", { entry: d.invalid }) : recipientsLine(d.toText)}
      </span>
    </button>
  );
}

/**
 * The one scheduled send (plan 94): its clock, what and to whom, and when it goes (in the destructive ink while a
 * try failed). A click opens Send later on it: Send now, a new time, or Edit message.
 */
function ScheduledRow({ s, handOver }: { s: ScheduledInfo; handOver: React.RefObject<boolean> }) {
  const ref = useRef<HTMLButtonElement>(null);
  useHandsOver(ref, handOver);
  const recipients = scheduledTo(s);
  return (
    <ScheduledPopover s={s} align="start">
      {(open) => (
        <PopoverTrigger
          render={
            <button
              ref={ref}
              type="button"
              data-testid="strip-scheduled"
              data-draft-id={s.draftId}
              aria-label={t("sendLater.item", { recipients: recipients || t("compose.strip.none"), when: reminderWhen(s.sendAt) })}
              className={cn(ROW, open ? "before:bg-row-hover" : "hover:before:bg-row-hover")}
            />
          }
        >
          <Clock className="relative size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="relative min-w-0 shrink-0 truncate font-medium">{scheduledSubject(s)}</span>
          <span className="relative min-w-0 flex-1 truncate text-muted-foreground">{recipients ? t("compose.strip.to", { recipients }) : t("compose.strip.none")}</span>
          <span className={cn("relative shrink-0 text-xs tabular", s.error ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-scheduled-when">
            {reminderShort(s.sendAt)}
          </span>
        </PopoverTrigger>
      )}
    </ScheduledPopover>
  );
}

// a menu item's second part: the row's own muted ink, at the body's weight
const ITEM_REST = "min-w-0 flex-1 truncate font-normal";

function DraftItem({ draftKey, choose }: { draftKey: string; choose: (key: string) => void }) {
  const d = useDraftLine(draftKey);
  if (!d) return null;
  return (
    <DropdownMenuItem data-testid="strip-item" data-key={draftKey} onClick={() => choose(draftKey)}>
      <PenLine className="text-draft-foreground" aria-hidden />
      <span className="min-w-0 shrink truncate">{draftSubject(d)}</span>
      <span className={cn(ITEM_REST, d.invalid !== null ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-item-recipients">
        {d.invalid !== null ? t("compose.strip.invalid", { entry: d.invalid }) : recipientsLine(d.toText)}
      </span>
    </DropdownMenuItem>
  );
}

function ScheduledItem({ s, choose }: { s: ScheduledInfo; choose: (s: ScheduledInfo) => void }) {
  const recipients = scheduledTo(s);
  return (
    // named by what it shows (subject, recipients, when): a label of its own wouldn't match it (axe)
    <DropdownMenuItem data-testid="strip-scheduled" data-draft-id={s.draftId} onClick={() => choose(s)}>
      <Clock aria-hidden />
      <span className="min-w-0 shrink truncate">{scheduledSubject(s)}</span>
      <span className={cn(ITEM_REST, "text-muted-foreground")}>{recipients ? t("compose.strip.to", { recipients }) : t("compose.strip.none")}</span>
      <span className={cn("shrink-0 text-xs font-normal tabular", s.error ? "text-destructive-ink" : "text-muted-foreground")} data-testid="strip-scheduled-when">
        {reminderShort(s.sendAt)}
      </span>
    </DropdownMenuItem>
  );
}

/** Whether `key` opened: shown in its conversation, on the reader pane, or pinned (each takes focus itself, maybe a frame later). */
const draftOpened = (key: string) => getApp().compose?.key === key || getApp().draftShown?.key === key || pinnedKey() === key;

/**
 * Several: one row that says how many, the trigger of a dropdown of them (plan 175). A draft chosen there opens as
 * from its own row and takes focus itself, so the menu hands focus over rather than giving it back to the row (as
 * the thread menu's Reply does); a scheduled send chosen there opens Send later on it, under the row, for as long as
 * it's scheduled.
 */
function Several({ drafts, scheduled, handOver }: { drafts: number; scheduled: readonly ScheduledInfo[]; handOver: React.RefObject<boolean> }) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useHandsOver(rowRef, handOver);
  const handOff = useRef(false);
  const draftPeople = useDraftPeople();
  const people = [...new Set([...draftPeople, ...scheduled.map((s) => s.to[0]?.name || s.to[0]?.email || "").filter(Boolean)])].slice(0, PEOPLE_SHOWN);
  const [picked, setPicked] = useState<number | null>(null);
  const pickedSend = picked === null ? undefined : scheduled.find((s) => s.draftId === picked);
  // sent, cancelled or moved elsewhere meanwhile: its Send later goes with it, and doesn't come back if it does
  useEffect(() => { if (picked !== null && !pickedSend) setPicked(null); }, [picked, pickedSend]);
  const chooseDraft = (key: string) => {
    handOff.current = true;
    const before = composeIntent();
    const opening = openFromRow(key);
    // (read after the open's own first step, which marks the selection)
    const selection = getSelectionWriteRevision();
    void opening.then(() => {
      // one that didn't open (gone, refused) leaves focus nowhere: back to the row, unless anything happened
      // meanwhile (a later open, a key that moved the selection: what that did has the focus)
      if (!draftOpened(key) && composeIntent() <= before + 1 && getSelectionWriteRevision() === selection && document.activeElement === document.body) rowRef.current?.focus({ preventScroll: true });
    });
  };
  const chooseScheduled = (s: ScheduledInfo) => {
    handOff.current = true;
    setPicked(s.draftId);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button ref={rowRef} type="button" data-testid="strip-summary" className={cn(ROW, "hover:before:bg-row-hover data-popup-open:before:bg-row-hover")} />}
        >
          {drafts > 0 ? <PenLine className="relative size-3.5 shrink-0 text-draft-foreground" aria-hidden /> : <Clock className="relative size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          {drafts > 0 && <span className="relative shrink-0 font-medium">{t("compose.strip.count", { count: drafts })}</span>}
          {drafts > 0 && scheduled.length > 0 && <span aria-hidden className="relative text-muted-foreground">·</span>}
          {scheduled.length > 0 && <span className={cn("relative shrink-0", drafts > 0 ? "text-muted-foreground" : "font-medium")}>{t("compose.strip.scheduled", { count: scheduled.length })}</span>}
          {people.length > 0 && <span className="relative min-w-0 flex-1 truncate text-muted-foreground" data-testid="strip-summary-people">{t("compose.strip.to", { recipients: people.join(", ") })}</span>}
          <ChevronDown className="relative ms-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-testid="strip-menu"
          aria-label={t("compose.strip.label")}
          className="max-h-[min(40vh,var(--available-height))]"
          finalFocus={() => {
            const handedOff = handOff.current;
            handOff.current = false;
            return !handedOff;
          }}
        >
          <MenuItems scheduled={scheduled} chooseDraft={chooseDraft} chooseScheduled={chooseScheduled} />
        </DropdownMenuContent>
      </DropdownMenu>
      {pickedSend && <ScheduledPopover s={pickedSend} align="start" open onOpenChange={(open) => { if (!open) setPicked(null); }} anchor={rowRef} finalFocus={rowRef} />}
    </>
  );
}

/** The dropdown's items, drafts newest first and then scheduled sends: mounted, and following the drafts, only while it's open. */
function MenuItems({ scheduled, chooseDraft, chooseScheduled }: { scheduled: readonly ScheduledInfo[]; chooseDraft: (key: string) => void; chooseScheduled: (s: ScheduledInfo) => void }) {
  const keys = useDraftKeys();
  return (
    <>
      {keys.map((key) => (
        <DraftItem key={key} draftKey={key} choose={chooseDraft} />
      ))}
      {scheduled.map((s) => (
        <ScheduledItem key={s.draftId} s={s} choose={chooseScheduled} />
      ))}
    </>
  );
}

/**
 * Plan 175: the drafts row, at the top of the list whenever anything is written and not sent: every draft wherever
 * it is, and scheduled sends. One is the row itself; several are one row that says how many and opens them as a
 * dropdown. Counting them all keeps it steady: while there's anything, it changes only in what it says, never in
 * height, and never when the reader moves, so `j` never moves a row under it. It comes with the first draft and goes
 * with the last.
 */
export function DraftsStrip() {
  const drafts = useDraftCount();
  const scheduled = useScheduled((s) => s.items);
  const rootRef = useRef<HTMLDivElement>(null);
  const handOver = useRef(false);
  const count = typeof drafts === "string" ? 1 : drafts;
  const total = count + scheduled.length;
  const shape = total > 1 ? "several" : typeof drafts === "string" ? `draft:${drafts}` : total === 1 ? `scheduled:${scheduled[0]!.draftId}` : "none";
  useLayoutEffect(() => {
    if (!handOver.current) return;
    handOver.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [shape]);
  if (total === 0) return null;
  return (
    <div ref={rootRef} className="hairline-b flex shrink-0 items-center py-1" data-testid="drafts-strip" role="group" aria-label={t("compose.strip.label")}>
      {total > 1 ? (
        <Several drafts={count} scheduled={scheduled} handOver={handOver} />
      ) : typeof drafts === "string" ? (
        <DraftRow key={drafts} draftKey={drafts} handOver={handOver} />
      ) : (
        <ScheduledRow key={scheduled[0]!.draftId} s={scheduled[0]!} handOver={handOver} />
      )}
    </div>
  );
}
