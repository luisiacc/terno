import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { CloseButton } from "@terno/ui/components/close-button";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { CircleCheck, OctagonX, TriangleAlert } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { clock, closeRoom, dockReserve, dismissSnack, elapsedAt, openRoom, pause, resume, runAction, staleOnMove, useSnack, zHolds, type Snack, type SnackAction } from "~/lib/snack";
import { useApp } from "~/state/app";
import { listKey } from "~/state/list";
import { READING_COLUMN } from "~/lib/pane-lines";
import { CountdownPill } from "./countdown-pill";

/** Plan 232: the open room's place (a SnackRoom's element), where the dock's card goes for a snack said in it. */
const useRoomPlace = create<{ el: HTMLElement | null }>(() => ({ el: null }));

/**
 * Plan 232: a modal surface's room for the dock (Settings). While it's open, what the user's own actions say is said
 * here, on the nearest positioned ancestor's foot, inside the modal: reachable, and its countdown runs. Open follows the
 * surface's open state, not its mount (a closing dialog stays mounted for its exit).
 */
export function SnackRoom({ name, open }: { name: string; open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    openRoom(name);
    useRoomPlace.setState({ el });
    return () => {
      useRoomPlace.setState((s) => (s.el === el ? { el: null } : s));
      // a remount (a language change remounts the app) puts a room back in the same commit: only an empty place closes it
      queueMicrotask(() => {
        if (useRoomPlace.getState().el === null) closeRoom(name);
      });
    };
  }, [name, open]);
  return <div ref={ref} className="contents" data-snack-room={name} />;
}

/** The dock's card, for F6. */
const dockRef: { current: HTMLDivElement | null } = { current: null };
/** Where focus was before it went into the dock: it goes back there when the content it was in goes away. */
let returnFocus: HTMLElement | null = null;

function giveFocusBack(): void {
  const back = returnFocus;
  returnFocus = null;
  if (back?.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
}

/** F6: the dock's primary action (else its close button) while a snack is up; the dock never takes focus by itself. */
export function focusDock(): boolean {
  const el = dockRef.current;
  if (!useSnack.getState().current || !el || covered(el)) return false;
  const target = el.querySelector<HTMLElement>("[data-snack-primary]:not(:disabled)") ?? el.querySelector<HTMLElement>("button:not(:disabled)");
  target?.focus();
  return !!target && el.contains(document.activeElement);
}

/** Plan 188: whether focus is in the dock's card, and where it came from (F6 goes on from that pane). */
export function inDock(el: Element | null): boolean {
  return !!el && !!dockRef.current?.contains(el);
}
export function dockCameFrom(): HTMLElement | null {
  return returnFocus;
}

/** The dock's primary action: the countdown pill on the current snack's lifetime (paused with it). */
export function SnackPill({ label, name, onClick, shortcut, disabled, testId = "snack-action" }: { label: string; name?: string; onClick: () => void; shortcut?: string; disabled?: boolean; testId?: string }) {
  const duration = useSnack((s) => s.current?.duration ?? 0);
  const seq = useSnack((s) => s.current?.seq);
  const countdown = useSnack((s) => s.countdown);
  return (
    <CountdownPill
      label={label}
      name={name}
      onClick={onClick}
      shortcut={shortcut}
      disabled={disabled}
      testId={testId}
      data-snack-primary
      countdown={{ duration, elapsed: () => elapsedAt(countdown, clock.now()), paused: countdown.since === null, sync: `${seq}:${countdown.elapsed}:${countdown.since}` }}
    />
  );
}

/** A quiet text button before the pill ("View"), on a snack's line. */
const SNACK_QUIET = "rounded-full font-medium text-muted-foreground duration-fast";

const TONE_ICON = {
  success: <CircleCheck className="size-3.5 shrink-0 text-success-ink" aria-hidden />,
  warning: <TriangleAlert className="size-3.5 shrink-0 text-star" aria-hidden />,
  error: <OctagonX className="size-3.5 shrink-0 text-destructive-ink" aria-hidden />,
  loading: <Spinner className="size-3.5 text-muted-foreground" aria-hidden />,
  neutral: null,
};

/** "Undo" alone says nothing to a screen reader: it names what it takes back. */
const nameOf = (a: SnackAction, s: Snack) => a.name ?? (a.label === t("common.undo") ? t("snack.undoName", { message: s.message }) : undefined);

/** A close button for any snack body: BoardUI's round one, a 24 px target. */
export function SnackClose({ onClick = () => dismissSnack() }: { onClick?: () => void }) {
  return <CloseButton size="sm" data-testid="snack-close" label={t("snack.dismiss")} onClick={onClick} />;
}

/**
 * Plan 158: a success is one line. What could follow from it (the same for similar mail, a rule for new mail) waits
 * behind this, and while it's open the countdown waits: those lines take reading. No mail is touched by opening it.
 * Plan 173 (the owner): named by what was just done ("Move similar…", "Archive similar…"), so it reads as an action.
 */
export function SnackMore({ open, onToggle, controls, action }: { open: boolean; onToggle: () => void; controls: string; action: "move" | "add" | "archive" | "trash" | "spam" }) {
  useEffect(() => {
    if (!open) return;
    pause("expanded");
    return () => resume("expanded");
  }, [open]);
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="xs" data-testid="snackbar-similar" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle} className={SNACK_QUIET} />}>
        {t(`offers.similar.${action}`)}
      </TooltipTrigger>
      <TooltipContent>{t("offers.similarHelp")}</TooltipContent>
    </Tooltip>
  );
}

function Row({ snack }: { snack: Snack }) {
  // plan 232: z doesn't reach into a room (a dialog keeps its keys)
  const z = useSnack((s) => !snack.room && zHolds(s, snack.action?.undo));
  const wraps = snack.tone === "error" || snack.tone === "warning";
  // the claims ledger's second batch: an action that reads as a sentence (Remove's offer) has its own line under the first
  // at any width, so the message ("Removed" and the item's words), Undo and the close button keep the card's width and the
  // offer its whole name: beside the message, an 8rem column clamped the item's words and cut "(via Calendar)" to "(vi…"
  const below = snack.secondary?.below === true;
  return (
    // the Codex code review of round 14's faults: in a narrow card (Split's reader at its minimum) a quiet action has its own
    // line under the first too, so neither the message, Undo nor the close button gives way
    <div className="@container/snack">
    <div className={cn("flex min-h-9 items-center gap-x-2 py-1.5 pr-1.5 pl-3 @max-[29rem]/snack:flex-wrap", below && "flex-wrap")}>
      {TONE_ICON[snack.tone]}
      {/* plan 210 (round 14's faults): beside a quiet action the message keeps room for its first line */}
      <div className={cn("min-w-0 flex-1 text-sm", snack.secondary && !below && "min-w-32 @max-[29rem]/snack:min-w-0")} data-testid="snack-message">
        {/* two lines before it's cut ("Done: Pay $58.71 for the City of Millbrook water and s…" was one), the whole in its title */}
        <p className={cn(wraps ? "line-clamp-3" : "line-clamp-2", snack.tone === "error" && "text-destructive-ink")} title={snack.message}>
          {snack.message}
        </p>
        {snack.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground" title={snack.description}>
            {snack.description}
          </p>
        )}
      </div>
      {snack.secondary && (
        <div className={cn(below ? "order-last flex min-w-0 basis-full" : "contents @max-[29rem]/snack:order-last @max-[29rem]/snack:flex @max-[29rem]/snack:basis-full", TONE_ICON[snack.tone] && (below ? "ps-5.5" : "@max-[29rem]/snack:ps-5.5"))}>
          <Button variant="ghost" size="xs" data-testid="snack-secondary" aria-label={snack.secondary.name} title={snack.secondary.label} onClick={() => runAction("secondary")} className={cn(SNACK_QUIET, "h-auto min-h-6 min-w-0 shrink py-1 text-start whitespace-normal", below ? "-ms-2" : "@max-[29rem]/snack:-ms-2")}>
            <span className="line-clamp-2 text-balance">{snack.secondary.label}</span>
          </Button>
        </div>
      )}
      {snack.action && <SnackPill label={snack.action.label} name={nameOf(snack.action, snack)} onClick={() => runAction("action")} shortcut={z ? "z" : undefined} />}
      <SnackClose />
    </div>
    </div>
  );
}

/** Is the dock out of reach: the web's blocking screen (#root inert), or a modal (Base UI hides everything outside it but live regions)? */
function covered(card: HTMLElement | null): boolean {
  return !!document.getElementById("root")?.inert || !!card?.closest("[aria-hidden=true]");
}

/**
 * The countdown waits while nobody can see or reach the dock: the window
 * hidden, a dialog over the app (the app's own, the first run, a report
 * preview: any modal marks the card aria-hidden), or the web's blocking
 * screen. Returns whether the app is behind that screen (announcements wait for it).
 */
function useWatchers(card: React.RefObject<HTMLDivElement | null>, inRoom: boolean): boolean {
  // plan 232: a dialog the card is in (its room) doesn't cover it
  const dialog = useApp((s) => s.dialog !== null) && !inRoom;
  const [inert, setInert] = useState(false);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const visibility = () => (document.visibilityState === "hidden" ? pause("hidden") : resume("hidden"));
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  // read again wherever the card goes (plan 232: into a room and back)
  useEffect(() => {
    const root = document.getElementById("root");
    const read = () => {
      setInert(!!root?.inert);
      // the mark lands on the card's wrapper, its column, or on the card; in a room, on the dialog's portal when a modal
      // opens over it (plan 232): anywhere above the card
      setModal(!!card.current?.closest("[aria-hidden=true]"));
    };
    read();
    const mo = new MutationObserver(read);
    if (root) mo.observe(root, { attributes: true, attributeFilter: ["inert"] });
    mo.observe(document.body, { attributes: true, attributeFilter: ["aria-hidden"], subtree: true });
    return () => mo.disconnect();
  }, [inRoom]);
  const blocked = dialog || inert || modal;
  useEffect(() => (blocked ? pause("blocked") : resume("blocked")), [blocked]);
  return inert;
}

/**
 * The docked snackbar (plan 13): one snack at a time, at the bottom of the
 * pane that isn't being worked in (plan 158: Split's reader, List's one pane), under menus and dialogs. Always mounted, so its live
 * regions exist before any text arrives (and a modal's aria-hidden sweep
 * spares them: Base UI keeps [aria-live]). It never takes focus; F6 goes to
 * it, Esc there closes it.
 */
export function SnackDock({ over }: { /** what it stands over: List's rows, or a conversation (Split's reader, List's page) */ over: "list" | "reader" }) {
  const current = useSnack((s) => s.current);
  const last = useSnack((s) => s.last);
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  /** the snack focus came into */
  const focusedSeq = useRef<number | undefined>(undefined);
  const shown = current ?? last;
  // plan 232: a snack said in a room (Settings) shows there, in a card of the room's own. The section, its live regions
  // and its card stay here, mounted: a modal hides what's outside it once, as it opens, so nothing here may be new
  const roomPlace = useRoomPlace((s) => s.el);
  const inRoom = !!roomPlace && !!shown?.room;
  const inert = useWatchers(cardRef, inRoom);
  // plan 158: Split's dock is over the reader; List's over its one pane. Plan 162 (after ai162-r02): it stands on a
  // page's own foot bar (the digest's Archive), so neither hides the other
  const lift = useSnack((s) => s.pageLift);
  /** an Undo on its way (its act and what it puts back): said on the dock, so a test can wait for it to land */
  const undoing = useSnack((s) => s.undoing > 0);
  /** over a conversation or a new message (Split's reader, List's page): on its column, its background */
  const overReader = over === "reader";
  // a confirmation with nothing to offer is about the list it was said in: another one makes it stale (plan 158). The
  // list's own identity, so every way to another list counts (a search's scope, a preview, a filter)
  useEffect(() => {
    let shownFor = listKey();
    return useApp.subscribe(() => {
      const key = listKey();
      if (key === shownFor) return;
      shownFor = key;
      const c = useSnack.getState().current;
      if (c && staleOnMove(c)) dismissSnack(c.id);
    });
  }, []);

  // the list keeps room for the dock below its last row (plan 232: in a room, the room's scroller does)
  const open = current !== null;
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const set = () => {
      const reserve = open ? dockReserve(el.offsetHeight) : 0;
      useSnack.setState(inRoom ? { inset: 0, roomInset: reserve } : { inset: reserve, roomInset: 0 });
    };
    set();
    if (!open) return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, inRoom]);

  // what faded out goes once the fade is over
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => useSnack.setState((s) => (s.current ? s : { last: null })), 200);
    return () => clearTimeout(t);
  }, [open]);

  // the content focus was in went away (closed, replaced, an action ran, plan 232: moved out of its room, which Chromium
  // reports with a blur, not every engine): focus goes back where it came from
  useLayoutEffect(() => {
    // closing leaves the old content in place for the fade: focus is in content that's going even if it's still there
    if (!focused.current || (open && cardRef.current?.contains(document.activeElement))) return;
    focused.current = false;
    resume("focus");
    giveFocusBack();
  }, [current?.seq, open, inRoom]);
  // plan 232: a card taken out of its room fires a blur but no pointerleave: the pointer that held it isn't over the new one
  useEffect(() => resume("hover"), [inRoom]);

  // said once, then out of the live region: browsing finds the visible text, not a second copy
  const [hushed, setHushed] = useState<number | null>(null);
  const heard = current?.heard;
  useEffect(() => {
    if (heard === undefined || inert) return;
    const t = setTimeout(() => setHushed(heard), 1500);
    return () => clearTimeout(t);
  }, [heard, inert]);

  // behind the web's blocking screen nothing is heard: the text goes in when it lifts
  const spoken = current && !inert && hushed !== current.heard ? current.spoken : "";
  const alert = current?.tone === "error";
  /** the card: the live one here or in the room; the one here always mounted, closed while the room has the snack */
  const card = (live: boolean) => (
    <div
      ref={
        live
          ? (el) => {
              cardRef.current = el;
              dockRef.current = el;
            }
          : undefined
      }
      data-snack-card
      data-testid={live && current ? "snack" : undefined}
      data-state={live && open ? "open" : "closed"}
      data-tone={live ? shown?.tone : undefined}
      // a new snack under a resting pointer runs (show() drops the old hover): moving over it holds it again
      onPointerEnter={() => current && pause("hover")}
      onPointerMove={() => current && pause("hover")}
      onPointerLeave={() => resume("hover")}
      onFocus={(e) => {
        if (!focused.current) returnFocus = e.relatedTarget instanceof HTMLElement && !e.currentTarget.contains(e.relatedTarget) ? e.relatedTarget : null;
        focused.current = true;
        focusedSeq.current = current?.seq;
        pause("focus");
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        // the browser drops focus from content that closed (hidden for its fade) before the effect above runs: same giving back
        const gone = e.relatedTarget === null && useSnack.getState().current?.seq !== focusedSeq.current;
        focused.current = false;
        resume("focus");
        if (gone) giveFocusBack();
        else returnFocus = null;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !current) return;
        // the document's shortcuts skip a handled key; in a room, the dialog's Esc (on the document) never hears it
        e.preventDefault();
        if (inRoom) e.stopPropagation();
        dismissSnack(current.id);
      }}
      className={cn(
        "snack-surface relative w-[min(100%,30rem)] overflow-hidden rounded-xl transition-[opacity,translate,visibility] duration-slow ease-motion",
        live && open ? "pointer-events-auto visible translate-y-0 opacity-100" : "invisible translate-y-1 opacity-0",
      )}
    >
      {live && shown && (
        <div key={shown.seq} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-slow">
          {shown.render ? shown.render() : <Row snack={shown} />}
        </div>
      )}
    </div>
  );
  const section = (
    <section aria-label={t("snack.dock")} data-testid="snack-dock" data-over={overReader ? "reader" : "list"} data-undoing={undoing || undefined} style={{ "--dock-lift": `${lift}px` } as React.CSSProperties} className={cn("pointer-events-none absolute bottom-[calc(var(--float-inset)+var(--dock-lift))] z-10 flex flex-col justify-end", overReader ? "@container inset-x-0 pe-(--scrollbar-w)" : "inset-x-(--float-inset) items-center")}>
      <div role="status" aria-live="polite" aria-atomic className="sr-only" data-testid="snack-live">
        {!alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic className="sr-only" data-testid="snack-alert">
        {alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      {/* what's under the dock dissolves into its pane: it reads as the pane's foot, not a card over it, across the whole
          width (plan 158): a band the conversation ends at (and scrolls clear of). Plan 160: List's rows end above the dock
          (the list's viewport stops there), so nothing is under it to fade */}
      {overReader && <div aria-hidden className={cn("pointer-events-none absolute -top-6 -bottom-(--float-inset) inset-x-0 bg-linear-to-t from-background from-40% to-transparent transition-opacity duration-slow", open && !inRoom ? "opacity-100" : "opacity-0")} />}
      {/* over a conversation: centred on the reader's column (plan 160: the section keeps the scroller's gutter, as the
          column's pane does); over List's rows, centred on the pane */}
      <div className={overReader ? cn(READING_COLUMN, "flex justify-center") : "contents"}>
      {card(!inRoom)}
      </div>
    </section>
  );
  return (
    <>
      {section}
      {/* plan 232: in a room, on its foot and inside the modal's DOM: its focus trap holds the card, a click in it isn't
          outside, and nothing marks it hidden. Centred, as over List's pane; no fade (Settings' foot has none, plan 162) */}
      {roomPlace && inRoom && createPortal(<div data-testid="snack-room-dock" className="pointer-events-none absolute inset-x-(--float-inset) bottom-(--float-inset) z-10 flex justify-center">{card(true)}</div>, roomPlace)}
    </>
  );
}
