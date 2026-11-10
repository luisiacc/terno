/**
 * Plan 176: whether a Terno window has the OS's focus, told to the backend as it changes; for a minute after Terno
 * comes to the front it checks the accounts without push every 5 s. Main tells it rather than the page: the OS knows
 * a window's focus, which a click into a mail frame hides from the page. Kept apart from Electron to be unit-tested.
 */

/** a switch between two Terno windows is a blur then a focus: read once both are in, so it isn't Terno losing focus */
export const FOCUS_SETTLE_MS = 50;

export interface FocusReporterOptions {
  /** a Terno window has focus now */
  focused(): boolean;
  /** tells the backend; false when there's none to tell (stopped, restarting, retiring) */
  tell(focused: boolean): boolean;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class FocusReporter {
  private told: boolean | null = null;
  private settling = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly o: FocusReporterOptions) {
    this.setTimer = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** a window gained or lost focus */
  changed(): void {
    if (this.settling) return;
    this.settling = true;
    this.setTimer(() => {
      this.settling = false;
      const now = this.o.focused();
      if (now !== this.told && this.o.tell(now)) this.told = now;
    }, FOCUS_SETTLE_MS);
  }

  /** a (re)started backend's init carries this; what it's told later is a change from it */
  current(): boolean {
    this.told = this.o.focused();
    return this.told;
  }
}
