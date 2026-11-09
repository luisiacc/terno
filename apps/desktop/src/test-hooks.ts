/**
 * Plan 161: what the UI rating's AI screens need from a test host, and only in the demo mailbox, which is never real
 * mail. A normal launch reaches none of it: without TERNO_DEMO, all three read as absent.
 *
 * - TERNO_TEST_NOW (epoch ms): the backend's clock starts there and runs on, so the demo's mail, dated around its own
 *   instant, is as fresh to the AI jobs (the digest's days, a reply's wait) in every round.
 * - TERNO_TEST_NET_LOG (an absolute path): every network policy decision, one JSON line each, so the harness can prove
 *   where the backend's requests went.
 * - TERNO_TEST_DEV_AI=1: Dev mode (plan 146) on the frozen rating build, which has no dev server. The rating runs the
 *   app's real AI path, Pro's routing on the keys its harness passes, as `pnpm dev:desktop` does; never packaged.
 */
import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { NetDecision } from "@terno/backend";

export function testClock(env: Record<string, string | undefined>, demo: boolean): number | null {
  if (!demo || !env.TERNO_TEST_NOW || !/^\d{13}$/.test(env.TERNO_TEST_NOW)) return null;
  return Number(env.TERNO_TEST_NOW);
}

export function testNetLog(env: Record<string, string | undefined>, demo: boolean): string | null {
  const path = env.TERNO_TEST_NET_LOG;
  return demo && path && isAbsolute(path) ? path : null;
}

/** Plan 161: Dev mode without a dev server, for the rating's real models. A packaged app never: its keys are the user's. */
export function testDevAi(env: Record<string, string | undefined>, packaged: boolean, demo: boolean): boolean {
  return demo && !packaged && env.TERNO_TEST_DEV_AI === "1";
}

/** A clock that reads `at` now and runs on at the real one's pace. */
export function offsetClock(at: number, real: () => number = Date.now): () => number {
  const shift = at - real();
  return () => real() + shift;
}

/** Bounded, like every log: a test that runs away stops being recorded rather than filling the disk, and says so. */
export const NET_LOG_MAX = 10_000;

export function netRecorder(path: string, write: (path: string, line: string) => void = appendFileSync): (decision: NetDecision) => void {
  let written = 0;
  return (decision) => {
    if (written > NET_LOG_MAX) return;
    // the last line marks the bound, so a reader can't take a cut log as a whole one
    write(path, `${JSON.stringify(written++ < NET_LOG_MAX ? decision : { overflow: true })}\n`);
  };
}
