/**
 * Plan 167: the demo's fixed clock in the window too. The backend's clock already starts at TERNO_TEST_NOW (test-hooks.ts);
 * without this the window reads the real one, so the list says 22 Oct where it means 15:30 and Later picks a day the
 * backend thinks is weeks away. Main passes the shift (ms) to each window as an argument, and the sandboxed preload runs
 * `shiftClock` in the page's world before any of its scripts. No Node imports: the preload can require only electron.
 */

export const CLOCK_ARG = "--terno-test-clock-shift=";

/** The window's argument for a shift, or none without one. */
export function clockArgs(shift: number | null): string[] {
  return shift === null ? [] : [`${CLOCK_ARG}${Math.round(shift)}`];
}

/** The shift a window was given, from its argv; null when it wasn't (every normal launch). */
export function clockShiftOf(argv: readonly string[]): number | null {
  const arg = argv.find((a) => a.startsWith(CLOCK_ARG));
  if (!arg) return null;
  const value = arg.slice(CLOCK_ARG.length);
  return /^-?\d{1,15}$/.test(value) ? Number(value) : null;
}

/**
 * Runs in the page's world (`contextBridge.executeInMainWorld`), so it is self-contained: `Date` and `Date.now()` read the
 * real clock plus `shift` and run on at its pace; a date given (`new Date(ms)`, `Date.UTC`, parsing) stays that date.
 */
export function shiftClock(shift: number, scope: { Date: DateConstructor } = globalThis): void {
  const Real = scope.Date;
  const now = () => Real.now() + shift;
  // a constructor that calls through to the real one: instanceof, statics and the prototype stay the real Date's
  const Shifted = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new Real(now()).toString();
    return args.length === 0 ? new Real(now()) : new (Real as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(Shifted, Real);
  Object.defineProperty(Shifted, "prototype", { value: Real.prototype });
  Object.defineProperty(Shifted, "now", { value: now, writable: true, configurable: true });
  scope.Date = Shifted;
}
