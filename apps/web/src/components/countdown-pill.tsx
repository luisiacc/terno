import { Kbd } from "@terno/ui/components/kbd";
import { chordLabel } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { cn } from "@terno/ui/lib/utils";
import { motionOff } from "@terno/ui/themes/apply";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppearance } from "~/lib/appearance";
import { useApp } from "~/state/app";

/** The pill's outline from the top centre, clockwise (crisp: drawn at the button's own size). */
function pillPath(w: number, h: number, stroke: number): string {
  const i = stroke / 2;
  const r = (h - stroke) / 2;
  const c = w / 2;
  return `M ${c} ${i} H ${w - i - r} A ${r} ${r} 0 0 1 ${w - i - r} ${h - i} H ${i + r} A ${r} ${r} 0 0 1 ${i + r} ${i} Z`;
}

const STROKE = 1.5;

/**
 * What the border counts down: `duration` in all, `elapsed()` of it gone as of now, held while `paused`. The animation is
 * set again whenever `sync` changes (a new countdown, a pause or a resume): the owner's clock is the truth, never this.
 */
export interface Countdown {
  duration: number;
  elapsed: () => number;
  paused: boolean;
  sync: unknown;
}

/**
 * The countdown on the pill's border: a Web Animation from the owner's clock. Motion off turns CSS animations off, not
 * this one: the time left is information, so it steps once a second instead of flowing. What ends is the owner's timer,
 * never this animation's end.
 */
function Ring({ size, countdown }: { size: { w: number; h: number }; countdown: Countdown }) {
  const ref = useRef<SVGPathElement>(null);
  const anim = useRef<Animation | null>(null);
  const still = useAppearance((s) => motionOff(s.motionMs, s.reducedMotion));
  const { duration, paused, sync } = countdown;
  const elapsed = useRef(countdown.elapsed);
  elapsed.current = countdown.elapsed;
  useLayoutEffect(() => {
    const path = ref.current;
    if (!path || !size.w) return;
    // closing (or a countdown that never ends): the ring holds where it was
    if (!Number.isFinite(duration) || duration <= 0) return void anim.current?.pause();
    anim.current?.cancel();
    const easing = still ? `steps(${Math.max(1, Math.round(duration / 1000))}, end)` : "linear";
    const a = path.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -100 }], { duration, easing, fill: "forwards", id: "pill-countdown" });
    a.currentTime = Math.min(duration, Math.max(0, elapsed.current()));
    if (paused) a.pause();
    anim.current = a;
  }, [duration, paused, sync, still, size.w, size.h]);
  useEffect(() => () => anim.current?.cancel(), []);
  if (!size.w) return null;
  const d = pillPath(size.w, size.h, STROKE);
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
      <path d={d} fill="none" stroke="var(--countdown-track)" strokeWidth={STROKE} />
      <path ref={ref} data-testid="countdown-ring" d={d} fill="none" stroke="var(--countdown-ring)" strokeWidth={STROKE} strokeLinecap="round" pathLength={100} strokeDasharray="100 100" />
    </svg>
  );
}

/**
 * Plan 161, pass 2: z is the last undo (`undoLast`), as ⌘Z (Ctrl+Z) is: the keycap shows the platform's undo, and
 * `aria-keyshortcuts` names both.
 */
const UNDO_CHORD = "mod+z";
// (the shortcut's own test of the platform: lib/select's would pull the list's state into every pill)
// plan 188 (Codex review): plain Z only while single keys are on (the keycap is ⌘Z, which always works)
const undoAria = (keys: boolean) => `${typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"}+Z${keys ? " Z" : ""}`;

/**
 * A pill whose border drains as its time runs out (the dock's Undo, plan 13; a sent message's Undo send, plan 182), with
 * its key as a quiet keycap while that key runs the same thing (z, the undo, shown as ⌘Z). `busy`: what it started is
 * under way (its spinner; it can't be pressed again).
 */
export function CountdownPill({ label, name, onClick, shortcut, disabled, busy, countdown, testId, className, ...data }: { label: string; name?: string; onClick: () => void; shortcut?: string; disabled?: boolean; busy?: boolean; countdown: Countdown; testId: string; className?: string } & { [key: `data-${string}`]: string | boolean | undefined }) {
  const ref = useRef<HTMLButtonElement>(null);
  const keys = useApp((s) => s.settings?.characterKeys !== false);
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
      {...data}
      aria-label={name}
      aria-keyshortcuts={shortcut === "z" ? undoAria(keys) : shortcut}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        // BoardUI's toast action is the secondary button: the card fill over a contact shadow, its border the ring's track
        "countdown-pill relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-card pl-2.5 text-xs font-medium whitespace-nowrap text-foreground shadow-xs transition-[background-color,transform] duration-fast hover:bg-muted active:scale-[0.97] disabled:opacity-60 aria-busy:opacity-100",
        shortcut ? "pr-1" : "pr-2.5",
        className,
      )}
    >
      <Ring size={size} countdown={countdown} />
      {busy && <Spinner aria-hidden className="size-3 text-muted-foreground" />}
      {label}
      {/* the key is aria-keyshortcuts; drawn as generated content so the button's text stays its label ("Undo" in "Undo archive") */}
      {shortcut && <Kbd aria-hidden data-key={chordLabel(shortcut === "z" ? UNDO_CHORD : shortcut)} className="h-4 min-w-4 rounded-full bg-tint px-1 text-2xs shadow-none after:content-[attr(data-key)]" />}
    </button>
  );
}
