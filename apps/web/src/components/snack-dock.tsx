import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Kbd } from "@terno/ui/components/kbd";
import { chordLabel } from "@terno/ui/components/shortcut";
import { cn } from "@terno/ui/lib/utils";
import { motionOff } from "@terno/ui/themes/apply";
import { CloseButton } from "@terno/ui/components/close-button";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { CircleCheck, OctagonX, TriangleAlert } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppearance } from "~/lib/appearance";
import { clock, dockReserve, dismissSnack, elapsedAt, pause, resume, runAction, staleOnMove, useSnack, zHolds, type Snack, type SnackAction } from "~/lib/snack";
import { useApp } from "~/state/app";
import { listKey } from "~/state/list";
import { READING_COLUMN } from "~/lib/pane-lines";

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
export function focusDock(): void {
  const el = dockRef.current;
  if (!useSnack.getState().current || !el || covered(el)) return;
  (el.querySelector<HTMLElement>("[data-snack-primary]:not(:disabled)") ?? el.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
}

/** The pill's outline from the top centre, clockwise (crisp: drawn at the button's own size). */
function pillPath(w: number, h: number, stroke: number): string {
  const i = stroke / 2;
  const r = (h - stroke) / 2;
  const c = w / 2;
  return `M ${c} ${i} H ${w - i - r} A ${r} ${r} 0 0 1 ${w - i - r} ${h - i} H ${i + r} A ${r} ${r} 0 0 1 ${i + r} ${i} Z`;
}

const STROKE = 1.5;

/**
 * The countdown on the pill's border: a Web Animation, synced to the store's
 * countdown whenever it pauses or resumes. Motion off turns CSS animations
 * off, not this one: the lifetime is information, so it steps once a second
 * instead of flowing. Expiry is the store's timer, never this animation's end.
 */
function Ring({ size }: { size: { w: number; h: number } }) {
  const ref = useRef<SVGPathElement>(null);
  const anim = useRef<Animation | null>(null);
  const duration = useSnack((s) => s.current?.duration ?? 0);
  const seq = useSnack((s) => s.current?.seq);
  const countdown = useSnack((s) => s.countdown);
  const still = useAppearance((s) => motionOff(s.motionMs, s.reducedMotion));
  useLayoutEffect(() => {
    const path = ref.current;
    if (!path || !size.w) return;
    // closing (or a snack that never expires): the ring holds where it was
    if (!Number.isFinite(duration) || duration <= 0) return void anim.current?.pause();
    anim.current?.cancel();
    const easing = still ? `steps(${Math.max(1, Math.round(duration / 1000))}, end)` : "linear";
    const a = path.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -100 }], { duration, easing, fill: "forwards", id: "snack-countdown" });
    a.currentTime = Math.min(duration, elapsedAt(countdown, clock.now()));
    if (countdown.since === null) a.pause();
    anim.current = a;
  }, [duration, seq, countdown, still, size.w, size.h]);
  useEffect(() => () => anim.current?.cancel(), []);
  if (!size.w) return null;
  const d = pillPath(size.w, size.h, STROKE);
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
      <path d={d} fill="none" stroke="var(--snack-track)" strokeWidth={STROKE} />
      <path ref={ref} data-testid="snack-ring" d={d} fill="none" stroke="var(--snack-ring)" strokeWidth={STROKE} strokeLinecap="round" pathLength={100} strokeDasharray="100 100" />
    </svg>
  );
}

/**
 * Plan 161, pass 2: every snack's z is the last undo (`undoLast`), as ⌘Z (Ctrl+Z) is: the keycap shows the platform's
 * undo, and `aria-keyshortcuts` names both.
 */
const UNDO_CHORD = "mod+z";
// (the shortcut's own test of the platform: lib/select's would pull the list's state into every snack)
const undoAria = () => `${typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"}+Z Z`;

/**
 * The primary action: a pill whose border drains over the snack's lifetime,
 * with its key as a quiet keycap while that key runs the same thing (z, the undo, shown as ⌘Z).
 */
export function SnackPill({ label, name, onClick, shortcut, disabled, testId = "snack-action" }: { label: string; name?: string; onClick: () => void; shortcut?: string; disabled?: boolean; testId?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      data-snack-primary
      aria-label={name}
      aria-keyshortcuts={shortcut === "z" ? undoAria() : shortcut}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // BoardUI's toast action is the secondary button: the card fill over a contact shadow, its border the ring's track
        "relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-card pl-2.5 text-xs font-medium whitespace-nowrap text-foreground shadow-xs transition-[background-color,transform] duration-fast hover:bg-muted active:scale-[0.97] disabled:opacity-60",
        shortcut ? "pr-1" : "pr-2.5",
      )}
    >
      <Ring size={size} />
      {label}
      {/* the key is aria-keyshortcuts; drawn as generated content so the button's text stays its label ("Undo" in "Undo archive") */}
      {shortcut && <Kbd aria-hidden data-key={chordLabel(shortcut === "z" ? UNDO_CHORD : shortcut)} className="h-4 min-w-4 rounded-full bg-tint px-1 text-2xs shadow-none after:content-[attr(data-key)]" />}
    </button>
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
  const z = useSnack((s) => zHolds(s, snack.action?.undo));
  const wraps = snack.tone === "error" || snack.tone === "warning";
  return (
    <div className="flex min-h-9 items-center gap-2 py-1.5 pr-1.5 pl-3">
      {TONE_ICON[snack.tone]}
      <div className="min-w-0 flex-1 text-sm" data-testid="snack-message">
        <p className={cn(wraps ? "line-clamp-3" : "truncate", snack.tone === "error" && "text-destructive-ink")} title={snack.message}>
          {snack.message}
        </p>
        {snack.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground" title={snack.description}>
            {snack.description}
          </p>
        )}
      </div>
      {snack.secondary && (
        <Button variant="ghost" size="xs" data-testid="snack-secondary" aria-label={snack.secondary.name} onClick={() => runAction("secondary")} className={SNACK_QUIET}>
          {snack.secondary.label}
        </Button>
      )}
      {snack.action && <SnackPill label={snack.action.label} name={nameOf(snack.action, snack)} onClick={() => runAction("action")} shortcut={z ? "z" : undefined} />}
      <SnackClose />
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
function useWatchers(card: React.RefObject<HTMLDivElement | null>): boolean {
  const dialog = useApp((s) => s.dialog !== null);
  const [inert, setInert] = useState(false);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const visibility = () => (document.visibilityState === "hidden" ? pause("hidden") : resume("hidden"));
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const root = document.getElementById("root");
    const read = () => {
      setInert(!!root?.inert);
      // (the mark lands on the card's wrapper, its column, or on the card)
      setModal(!!card.current?.closest("[aria-hidden=true]"));
    };
    read();
    const mo = new MutationObserver(read);
    if (root) mo.observe(root, { attributes: true, attributeFilter: ["inert"] });
    if (card.current) for (const el of [card.current, card.current.parentElement]) if (el) mo.observe(el, { attributes: true, attributeFilter: ["aria-hidden"] });
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      mo.disconnect();
    };
  }, []);
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
  const inert = useWatchers(cardRef);
  // plan 158: Split's dock is over the reader; List's over its one pane, standing on the drafts strip while the list
  // shows (a page over the list covers the strip)
  // (List's rows: standing on the drafts strip at their foot)
  // plan 162 (after ai162-r02): and on a page's own foot bar (the digest's Archive), so neither hides the other
  const lift = useSnack((s) => Math.max(over === "list" ? s.lift : 0, s.pageLift));
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

  // the list keeps room for the dock below its last row
  const open = current !== null;
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const set = () => useSnack.setState({ inset: open ? dockReserve(el.offsetHeight) : 0 });
    set();
    if (!open) return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // what faded out goes once the fade is over
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => useSnack.setState((s) => (s.current ? s : { last: null })), 200);
    return () => clearTimeout(t);
  }, [open]);

  // the content focus was in went away (closed, replaced, an action ran): focus goes back where it came from
  useLayoutEffect(() => {
    // closing leaves the old content in place for the fade: focus is in content that's going even if it's still there
    if (!focused.current || (open && cardRef.current?.contains(document.activeElement))) return;
    focused.current = false;
    resume("focus");
    giveFocusBack();
  }, [current?.seq, open]);

  // said once, then out of the live region: browsing finds the visible text, not a second copy
  const [hushed, setHushed] = useState<number | null>(null);
  const heard = current?.heard;
  useEffect(() => {
    if (heard === undefined || inert) return;
    const t = setTimeout(() => setHushed(heard), 1500);
    return () => clearTimeout(t);
  }, [heard, inert]);

  const shown = current ?? last;
  // behind the web's blocking screen nothing is heard: the text goes in when it lifts
  const spoken = current && !inert && hushed !== current.heard ? current.spoken : "";
  const alert = current?.tone === "error";
  return (
    <section aria-label={t("snack.dock")} data-testid="snack-dock" data-over={overReader ? "reader" : "list"} style={{ "--dock-lift": `${lift}px` } as React.CSSProperties} className={cn("pointer-events-none absolute bottom-[calc(var(--float-inset)+var(--dock-lift))] z-10 flex flex-col justify-end", overReader ? "@container inset-x-0 pe-(--scrollbar-w)" : "inset-x-(--float-inset) items-center")}>
      <div role="status" aria-live="polite" aria-atomic className="sr-only" data-testid="snack-live">
        {!alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic className="sr-only" data-testid="snack-alert">
        {alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      {/* what's under the dock dissolves into its pane: it reads as the pane's foot, not a card over it, across the whole
          width (plan 158): a band the conversation ends at (and scrolls clear of). Plan 160: List's rows end above the dock
          (the list's viewport stops there), so nothing is under it to fade */}
      {overReader && <div aria-hidden className={cn("pointer-events-none absolute -top-6 -bottom-(--float-inset) inset-x-0 bg-linear-to-t from-background from-40% to-transparent transition-opacity duration-slow", open ? "opacity-100" : "opacity-0")} />}
      {/* over a conversation: centred on the reader's column (plan 160: the section keeps the scroller's gutter, as the
          column's pane does); over List's rows, centred on the pane */}
      <div className={overReader ? cn(READING_COLUMN, "flex justify-center") : "contents"}>
      <div
        ref={(el) => {
          cardRef.current = el;
          dockRef.current = el;
        }}
        data-snack-card
        data-testid={current ? "snack" : undefined}
        data-state={open ? "open" : "closed"}
        data-tone={shown?.tone}
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
          // the document's shortcuts skip a handled key
          e.preventDefault();
          dismissSnack(current.id);
        }}
        className={cn(
          "snack-surface relative w-[min(100%,30rem)] overflow-hidden rounded-xl transition-[opacity,translate,visibility] duration-slow ease-motion",
          open ? "pointer-events-auto visible translate-y-0 opacity-100" : "invisible translate-y-1 opacity-0",
        )}
      >
        {shown && (
          <div key={shown.seq} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-slow">
            {shown.render ? shown.render() : <Row snack={shown} />}
          </div>
        )}
      </div>
      </div>
    </section>
  );
}
