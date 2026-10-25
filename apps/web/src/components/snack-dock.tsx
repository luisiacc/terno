import { t } from "@terno/i18n";
import { Kbd } from "@terno/ui/components/kbd";
import { cn } from "@terno/ui/lib/utils";
import { motionOff } from "@terno/ui/themes/apply";
import { CircleCheck, Loader2, OctagonX, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppearance } from "~/lib/appearance";
import { clock, dismissSnack, elapsedAt, pause, resume, runAction, useSnack, zHolds, type Snack, type SnackAction } from "~/lib/snack";
import { useApp } from "~/state/app";

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
 * The primary action: a pill whose border drains over the snack's lifetime,
 * with z as a quiet keycap while z runs the same thing.
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
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pl-2.5 text-xs font-medium whitespace-nowrap text-foreground transition-[background-color,transform] duration-fast hover:bg-tint active:scale-[0.97] disabled:opacity-60",
        shortcut ? "pr-1" : "pr-2.5",
      )}
    >
      <Ring size={size} />
      {label}
      {/* the key is aria-keyshortcuts; drawn as generated content so the button's text stays its label ("Undo" in "Undo archive") */}
      {shortcut && <Kbd aria-hidden data-key={shortcut} className="h-4 min-w-4 rounded-full bg-tint px-1 text-2xs shadow-none after:content-[attr(data-key)]" />}
    </button>
  );
}

const TONE_ICON = {
  success: <CircleCheck className="size-3.5 shrink-0 text-success-ink" aria-hidden />,
  warning: <TriangleAlert className="size-3.5 shrink-0 text-star" aria-hidden />,
  error: <OctagonX className="size-3.5 shrink-0 text-destructive-ink" aria-hidden />,
  loading: <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />,
  neutral: null,
};

/** "Undo" alone says nothing to a screen reader: it names what it takes back. */
const nameOf = (a: SnackAction, s: Snack) => a.name ?? (a.label === t("common.undo") ? t("snack.undoName", { message: s.message }) : undefined);

/** A close button for any snack body (a 24 px target around a small glyph). */
export function SnackClose({ onClick = () => dismissSnack() }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      data-testid="snack-close"
      aria-label={t("snack.dismiss")}
      onClick={onClick}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-tint hover:text-foreground"
    >
      <X className="size-3" />
    </button>
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
        <button
          type="button"
          data-testid="snack-secondary"
          aria-label={snack.secondary.name}
          onClick={() => runAction("secondary")}
          className="inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors duration-fast hover:bg-tint hover:text-foreground"
        >
          {snack.secondary.label}
        </button>
      )}
      {snack.action && <SnackPill label={snack.action.label} name={nameOf(snack.action, snack)} onClick={() => runAction("action")} shortcut={z ? "z" : undefined} />}
      <SnackClose />
    </div>
  );
}

/** Is the dock out of reach: the web's blocking screen (#root inert), or a modal (Base UI hides everything outside it but live regions)? */
function covered(card: HTMLElement | null): boolean {
  return !!document.getElementById("root")?.inert || card?.getAttribute("aria-hidden") === "true";
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
      setModal(card.current?.getAttribute("aria-hidden") === "true");
    };
    read();
    const mo = new MutationObserver(read);
    if (root) mo.observe(root, { attributes: true, attributeFilter: ["inert"] });
    if (card.current) mo.observe(card.current, { attributes: true, attributeFilter: ["aria-hidden"] });
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
 * The docked snackbar (plan 13): one snack at a time, embedded at the bottom
 * of the thread list, under menus and dialogs. Always mounted, so its live
 * regions exist before any text arrives (and a modal's aria-hidden sweep
 * spares them: Base UI keeps [aria-live]). It never takes focus; F6 goes to
 * it, Esc there closes it.
 */
export function SnackDock() {
  const current = useSnack((s) => s.current);
  const last = useSnack((s) => s.last);
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  /** the snack focus came into */
  const focusedSeq = useRef<number | undefined>(undefined);
  const inert = useWatchers(cardRef);

  // the list keeps room for the dock below its last row
  const open = current !== null;
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const set = () => useSnack.setState({ inset: open ? Math.ceil(el.offsetHeight) + 16 : 0 });
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
    <section aria-label={t("snack.dock")} data-testid="snack-dock" className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col justify-end">
      <div role="status" aria-live="polite" aria-atomic className="sr-only" data-testid="snack-live">
        {!alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic className="sr-only" data-testid="snack-alert">
        {alert && spoken && <span key={current?.heard}>{spoken}</span>}
      </div>
      {/* the rows dissolve into the pane under the dock: it reads as part of the list, not a card over it */}
      <div aria-hidden className={cn("pointer-events-none absolute -inset-x-2 -top-6 -bottom-2 bg-linear-to-t from-pane from-40% to-transparent transition-opacity duration-slow", open ? "opacity-100" : "opacity-0")} />
      <div
        ref={(el) => {
          cardRef.current = el;
          dockRef.current = el;
        }}
        data-testid={current ? "snack" : undefined}
        data-state={open ? "open" : "closed"}
        data-tone={shown?.tone}
        onPointerEnter={() => current && pause("hover")}
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
          "snack-surface relative overflow-hidden rounded-[calc(var(--radius-lg)+2px)] transition-[opacity,translate,visibility] duration-slow ease-motion",
          open ? "pointer-events-auto visible translate-y-0 opacity-100" : "invisible translate-y-1 opacity-0",
        )}
      >
        {shown && (
          <div key={shown.seq} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-slow">
            {shown.render ? shown.render() : <Row snack={shown} />}
          </div>
        )}
      </div>
    </section>
  );
}
