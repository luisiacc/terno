/**
 * Render counter for the perf tests: `window.__renders[name]++` on every
 * render of a probed component. Only test builds set VITE_RENDER_PROBE; in
 * every other build the body is dead code and the call compiles to nothing.
 */
export function renderProbe(name: string): void {
  if (import.meta.env.VITE_RENDER_PROBE) {
    const w = window as unknown as { __renders?: Record<string, number> };
    const r = (w.__renders ??= {});
    r[name] = (r[name] ?? 0) + 1;
  }
}

/**
 * Regressions a perf gate injects into a test build to show it would catch
 * them (plan 24's twins). Read only behind VITE_RENDER_PROBE.
 */
export const regressions: { remountList?: boolean } = {};

/** Test builds expose a few internals to the perf spec (window.__terno). */
export function exposeForTests(hooks: Record<string, unknown>): void {
  if (import.meta.env.VITE_RENDER_PROBE) Object.assign(((window as unknown as { __terno?: object }).__terno ??= {}), hooks);
}
