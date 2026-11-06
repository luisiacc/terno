import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useState, useSyncExternalStore } from "react";

export const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
export const whenTag = () => (getLocale() === "en" ? "en-US" : getLocale());
export const dayText = (d: Date | number) => new Intl.DateTimeFormat(whenTag(), { weekday: "short", month: "short", day: "numeric" }).format(d).replace(/\./g, "");

type Fields = typeof import("./when-fields");
let loading: Promise<void> | null = null;
let loaded: Fields | null = null;
let failed = false;
const listeners = new Set<() => void>();
const publish = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const load = () => {
  if (loading) return;
  failed = false;
  publish();
  loading = import("./when-fields").then(
    (m) => {
      loaded = m;
      publish();
    },
    // said where the fields would be, with a retry; the presets work without them, and the next picker tries again too
    () => {
      loading = null;
      failed = true;
      publish();
    },
  );
};

/**
 * A day and a time of day (local), starting at `start`; `chosen` is the moment they make. The time is null while a
 * segment of it is cleared (plan 122) or its fields aren't in yet: not `ready`, so nothing can be set that wasn't seen.
 * A picker opening is what asks for the fields' chunk, so Custom has them by the time it is clicked.
 */
export function useWhen(start: number) {
  const s = new Date(start);
  const [day, setDay] = useState(midnight(s));
  const [minutes, setMinutes] = useState<number | null>(s.getHours() * 60 + s.getMinutes());
  const [complete, setComplete] = useState(true);
  const fields = useSyncExternalStore(subscribe, () => loaded);
  const ready = fields !== null && minutes !== null && complete;
  const chosen = ready ? at(day, minutes) : Number.NaN;
  useEffect(load, []);
  return { day, setDay, minutes, setMinutes, setComplete, chosen, ready, past: ready && chosen <= Date.now() };
}

/**
 * The calendar and the Time Field (236 KB), kept out of the pickers so those can open at once. Not `lazy`: React holds a
 * Suspense reveal until 300 ms after its fallback, however soon the code is in. Once loaded they render in the same
 * commit; before that (a click faster than the chunk), a line of their height, or what went wrong.
 */
export function WhenFields(props: Parameters<Fields["WhenFields"]>[0]) {
  const fields = useSyncExternalStore(subscribe, () => loaded);
  const unavailable = useSyncExternalStore(subscribe, () => failed);
  if (fields) return <fields.WhenFields {...props} />;
  if (!unavailable) return <div className="h-8" aria-hidden />;
  return (
    <div role="alert" className="flex min-h-8 items-center justify-between gap-2 px-2 text-xs text-destructive-ink" data-testid="when-failed">
      {t("remind.fieldsFailed")}
      <Button type="button" variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" data-testid="when-retry" onClick={load}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
