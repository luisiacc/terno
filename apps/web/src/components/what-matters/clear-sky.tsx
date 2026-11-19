import { t } from "@terno/i18n";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ARC, countClearDay, nextChange, nextUp, sunPlace, type Moment } from "~/lib/clear";
import { freeUntil } from "~/lib/when";
import { useToday } from "~/state/today";

/**
 * Plan 222: a clear What matters (nothing missed, due today or waiting on you): the horizon with the sun where the clock has
 * it, what you're free until, and the clear days counted on this machine. The same scene in light and dark (the palette's
 * colours, never the clock's night). Read again when the window comes back (focus, visible) and at the one moment the words
 * would change by the clock alone (`nextChange`: a time passing, midnight), never on a polling timer.
 */
export function ClearSky() {
  const moments = useToday((s) => s.moments);
  const ref = useRef<HTMLDivElement>(null);
  const { now, n } = useClearMoment(ref, moments);
  const d = new Date(now);
  return (
    <div ref={ref} className="flex flex-col items-center text-center" data-testid="wm-clear">
      <Horizon hour={d.getHours() + d.getMinutes() / 60} />
      <p className="mt-3 text-lg font-semibold tracking-tight" data-testid="wm-clear-words">
        {freeUntil(nextUp(moments, now), now)}
      </p>
      {n !== null && (
        <p className="mt-0.5 text-xs text-muted-foreground tabular" data-testid="wm-clear-day">
          {t("whatMatters.clear.day", { n })}
        </p>
      )}
    </div>
  );
}

/**
 * The moment it's drawn for, read on mount, when the window is back and at the clock's next change; and today's clear day,
 * counted only once the horizon is on screen in a visible window (a virtualized row can be drawn out of view, Codex's plan
 * critique, 9), and again past midnight. The number stays hidden until it's counted.
 */
function useClearMoment(ref: RefObject<HTMLElement | null>, moments: readonly Moment[]): { now: number; n: number | null } {
  const [moment, setMoment] = useState<{ now: number; n: number | null }>(() => ({ now: Date.now(), n: null }));
  useEffect(() => {
    let inView = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const n = inView ? countClearDay(now) : undefined;
      setMoment((was) => ({ now, n: n === undefined ? was.n : n }));
      // (a timer's longest wait is about 24.8 days; midnight comes first)
      timer = setTimeout(seen, Math.max(1000, nextChange(moments, now) - now));
    };
    const io = new IntersectionObserver(([e]) => {
      const was = inView;
      inView = e?.isIntersecting === true;
      if (inView && !was) seen();
    });
    if (ref.current) io.observe(ref.current);
    seen();
    window.addEventListener("focus", seen);
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearTimeout(timer);
      io.disconnect();
      window.removeEventListener("focus", seen);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [ref, moments]);
  return moment;
}

/**
 * The horizon: a hairline, the sun's dotted track over it, and the sun on it in the palette's warm `star` with a soft glow.
 * Before 6:00 and after 18:00 it rests half-hidden at the track's feet. Decorative:
 * the words beside it say everything.
 */
function Horizon({ hour }: { hour: number }) {
  const id = useId();
  const sun = sunPlace(hour);
  const line = ARC.from[1];
  return (
    <svg viewBox="0 -24 440 120" className="w-full max-w-[440px]" aria-hidden data-testid="wm-horizon" data-sun={sun.up ? "up" : "resting"}>
      <path d={`M${ARC.from.join(" ")} Q${ARC.top.join(" ")} ${ARC.to.join(" ")}`} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeDasharray="1 5" strokeLinecap="round" />
      <g className="text-star">
        <defs>
          <radialGradient id={`${id}glow`}>
            <stop offset="0" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="1" stopColor="currentColor" stopOpacity={0} />
          </radialGradient>
          <clipPath id={`${id}sky`}>
            <rect x="0" y="-24" width="440" height={line + 24} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}sky)`}>
          <circle cx={sun.x} cy={sun.y} r="40" fill={`url(#${id}glow)`} />
          <circle cx={sun.x} cy={sun.y} r="8.5" fill="currentColor" />
        </g>
      </g>
      <path d={`M0 ${line}H440`} stroke="currentColor" strokeOpacity={0.18} />
    </svg>
  );
}
