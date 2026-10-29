import { t } from "@terno/i18n";
import type { ReactNode } from "react";
import { create } from "zustand";

/**
 * The docked snackbar's state (plan 13): one snack at a time, docked at the
 * bottom of the thread list. A user's snack replaces the current one; a
 * snack with the current one's id updates it in place; background news waits
 * behind the user's own snacks. Its lifetime is a countdown that pauses
 * while the dock is hovered or focused, the window is hidden, or a dialog or
 * blocking screen covers the app. No React here: anything can call it.
 */

export type SnackTone = "neutral" | "success" | "warning" | "error" | "loading";

/**
 * z / ⌘Z and a snack's Undo run the same token, once: `running` while it
 * works, `done` after; a failure makes it `ready` again (the undos are idempotent).
 */
export interface Undo {
  readonly run: () => unknown;
  state: "ready" | "running" | "done";
}

export interface SnackAction {
  label: string;
  /** not needed with `undo` */
  onClick?: () => void;
  /** the accessible name when the label alone is ambiguous ("Undo archive") */
  name?: string;
  /** the undo it runs: its z keycap shows while z would run the same one */
  undo?: Undo;
}

export interface SnackInput {
  /** a snack with the current one's id updates it in place */
  id?: string;
  message: string;
  /** a second, quieter line */
  description?: string;
  /** the primary action: a pill whose border is the countdown */
  action?: SnackAction;
  /** a quiet text button before it ("View") */
  secondary?: SnackAction;
  /** ms; loading snacks never expire */
  duration?: number;
  tone?: SnackTone;
  /** news nobody just asked for (a send's result, the engine's adds): waits behind a snack that offers something */
  background?: boolean;
}

export interface Snack extends Omit<SnackInput, "id" | "duration" | "tone" | "background"> {
  id: string;
  /** a new snack (not an update): its content enters and is announced */
  seq: number;
  tone: SnackTone;
  duration: number;
  /** what the live region says (progress updates don't change it) */
  spoken: string;
  /** changes each time it's to be said (a new snack, an error in place) */
  heard: number;
  /** a custom body (the categorization snackbar) in the dock's surface */
  render?: () => ReactNode;
  /** background news (or a late job result): other news may replace it, the user's own snacks hold against it */
  news?: boolean;
}

export type PauseReason = "hover" | "focus" | "hidden" | "blocked" | "busy";

/** Elapsed time of the current snack: `elapsed` until `since` (null while paused), then running. */
export interface Countdown {
  elapsed: number;
  since: number | null;
}

/** As today's toasts: 4 s; one with an action, or an error, 6 s (a pointer has to reach the list's bottom, an error says more). */
export const DEFAULT_MS = 4000;
export const ACTION_MS = 6000;
/** Background snacks waiting their turn, newest kept. */
const QUEUE_MAX = 3;

export const clock = { now: (): number => performance.now() };

interface SnackState {
  current: Snack | null;
  /** what the dock draws: the current snack, or the one fading out */
  last: Snack | null;
  countdown: Countdown;
  paused: readonly PauseReason[];
  /** z's undo, until another replaces it */
  undo: Undo | null;
  /** the dock's height plus its gaps while it shows: the list keeps that much room below its last row */
  inset: number;
}

export const useSnack = create<SnackState>(() => ({ current: null, last: null, countdown: { elapsed: 0, since: null }, paused: [], undo: null, inset: 0 }));

let seq = 0;
let heard = 0;
let ids = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: (SnackInput & { render?: () => ReactNode })[] = [];
/** loading snacks another one replaced: their results wait their turn instead of taking the dock back */
const displaced = new Set<string>();

export function elapsedAt(c: Countdown, now: number): number {
  return c.elapsed + (c.since === null ? 0 : now - c.since);
}

/** What's left of the current snack's lifetime (Infinity for one that never expires, 0 for none). */
export function remaining(state: SnackState = useSnack.getState(), now = clock.now()): number {
  if (!state.current) return 0;
  return Math.max(0, state.current.duration - elapsedAt(state.countdown, now));
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const s = useSnack.getState();
  if (!s.current || s.countdown.since === null || !Number.isFinite(s.current.duration)) return;
  const id = s.current.id;
  timer = setTimeout(() => dismissSnack(id), remaining(s));
}

const fresh = (paused: readonly PauseReason[]): Countdown => ({ elapsed: 0, since: paused.length ? null : clock.now() });
const spokenOf = (s: { message: string; description?: string }) => (s.description ? `${s.message}. ${s.description}` : s.message);

function durationOf(input: SnackInput): number {
  if (input.tone === "loading") return Infinity;
  return input.duration ?? (input.action || input.tone === "error" ? ACTION_MS : DEFAULT_MS);
}

/** Does the current snack hold the dock against background news? */
function holds(s: SnackState): boolean {
  const c = s.current;
  if (!c) return false;
  if (c.render || c.action || c.tone === "error" || s.paused.includes("hover") || s.paused.includes("focus")) return true;
  // what the user just did is read before anything they didn't ask for (a job's progress isn't something to read)
  return !c.news && c.tone !== "loading";
}

function show(input: SnackInput & { render?: () => ReactNode }): string {
  const s = useSnack.getState();
  const tone = input.tone ?? "neutral";
  const { id: _, duration: __, background, ...rest } = input;
  if (input.id !== undefined && s.current?.id === input.id) {
    // an update: same entry, the lifetime starts over (a loading snack's result gets its whole time)
    const current: Snack = { ...s.current, description: undefined, action: undefined, secondary: undefined, ...rest, tone, duration: durationOf(input), spoken: spokenOf(input), heard: ++heard };
    useSnack.setState({ current, last: current, countdown: fresh(s.paused) });
    schedule();
    return input.id;
  }
  const id = input.id ?? `snack-${++ids}`;
  const late = input.id !== undefined && displaced.delete(input.id);
  const news = !!background || late;
  if (news && holds(s)) {
    queue = [...queue.filter((q) => q.id !== id), { ...input, id, background: true }].slice(-QUEUE_MAX);
    return id;
  }
  if (s.current?.tone === "loading") displaced.add(s.current.id);
  const current: Snack = { ...rest, id, seq: ++seq, tone, duration: durationOf(input), spoken: spokenOf(input), heard: ++heard, news };
  useSnack.setState({ current, last: current, countdown: fresh(s.paused) });
  schedule();
  return id;
}

type Options = Omit<SnackInput, "message" | "tone">;

/** Shows a snack in the dock, replacing whatever is there; returns its id. */
export const snack = Object.assign((input: SnackInput | string, options?: Options): string => show(typeof input === "string" ? { ...options, message: input } : input), {
  success: (message: string, options?: Options) => show({ ...options, message, tone: "success" }),
  warning: (message: string, options?: Options) => show({ ...options, message, tone: "warning" }),
  error: (message: string, options?: Options) => show({ ...options, message, tone: "error" }),
  /** stays until its id is updated or dismissed */
  loading: (message: string, options?: Options) => show({ ...options, message, tone: "loading" }),
  /** a job's progress: only while its snack is still the one shown (never takes the dock back), and not announced */
  progress: (id: string, message: string) => patchSnack(id, { message }),
  /** a body of its own in the dock's surface; `message` is what's announced */
  custom: (input: { id?: string; message: string; duration: number; render: () => ReactNode }) => show(input),
});

/** Changes the current snack if it's still `id`: no new entry, the lifetime runs on; `announce` says it again. */
export function patchSnack(id: string, patch: Partial<Pick<Snack, "message" | "description" | "tone">>, announce = false): void {
  const s = useSnack.getState();
  if (s.current?.id !== id) return;
  const next = { ...s.current, ...patch };
  const current = announce ? { ...next, spoken: spokenOf(next), heard: ++heard } : next;
  useSnack.setState({ current, last: current });
}

/** Closes the current snack (only if it's `id`, when given); a queued one takes its place. */
export function dismissSnack(id?: string): void {
  const s = useSnack.getState();
  if (!s.current || (id !== undefined && s.current.id !== id)) return;
  if (timer) clearTimeout(timer);
  timer = null;
  displaced.delete(s.current.id);
  useSnack.setState({ current: null, countdown: { elapsed: 0, since: null } });
  // a queued result whose undo already ran (z meanwhile) has nothing left to say
  let next = queue.shift();
  while (next?.action?.undo && next.action.undo.state !== "ready") next = queue.shift();
  if (next) show(next);
}

/** What `id` said no longer holds (plan 25: the account signed in): gone from the dock, and from the queue if it waits there. */
export function withdrawSnack(id: string): void {
  queue = queue.filter((q) => q.id !== id);
  displaced.delete(id);
  dismissSnack(id);
}

/** A click on an action: the snack closes first, so whatever the action shows next stays. */
export function runAction(which: "action" | "secondary"): void {
  const current = useSnack.getState().current;
  const action = current?.[which];
  if (!current || !action) return;
  dismissSnack(current.id);
  const undo = action.undo;
  if (undo) runUndo(undo).catch((e: unknown) => undoFailed(e, undo));
  else action.onClick?.();
}

export function pause(reason: PauseReason): void {
  const s = useSnack.getState();
  if (s.paused.includes(reason)) return;
  const countdown = s.countdown.since === null ? s.countdown : { elapsed: elapsedAt(s.countdown, clock.now()), since: null };
  useSnack.setState({ paused: [...s.paused, reason], countdown });
  schedule();
}

export function resume(reason: PauseReason): void {
  const s = useSnack.getState();
  if (!s.paused.includes(reason)) return;
  const paused = s.paused.filter((r) => r !== reason);
  const countdown = paused.length || s.countdown.since !== null ? s.countdown : { elapsed: s.countdown.elapsed, since: clock.now() };
  useSnack.setState({ paused, countdown });
  schedule();
}

/** z's undo from now on (an action, a filing, a discarded draft, a compose conversion). */
export function registerUndo(run: () => unknown): Undo {
  const undo: Undo = { run, state: "ready" };
  useSnack.setState({ undo });
  return undo;
}

/**
 * Runs an undo once, from z or a button: the snack offering it goes, z stops
 * pointing at it. A failure (thrown or rejected) makes it ready again, z
 * points back at it unless a newer undo took its place, and it rethrows.
 */
export async function runUndo(undo: Undo): Promise<void> {
  if (undo.state !== "ready") return;
  undo.state = "running";
  const s = useSnack.getState();
  if (s.current?.action?.undo === undo) dismissSnack(s.current.id);
  if (useSnack.getState().undo === undo) useSnack.setState({ undo: null });
  try {
    await undo.run();
    undo.state = "done";
  } catch (error) {
    undo.state = "ready";
    if (useSnack.getState().undo === null) useSnack.setState({ undo });
    throw error;
  }
}

/** An undo that failed says so, with a retry of the same undo (they're idempotent). */
function undoFailed(error: unknown, undo: Undo): void {
  snack.error(t("snack.undoFailed", { error: error instanceof Error ? error.message : String(error) }), { action: { label: t("common.retry"), name: t("snack.retryUndo"), undo } });
}

/** A snack body's own Undo button: runs it once, a failure says so with a retry. */
export function undoNow(undo: Undo): void {
  runUndo(undo).catch((e: unknown) => undoFailed(e, undo));
}

/** z: the last undo, if it's still there. */
export function undoLast(): void {
  const undo = useSnack.getState().undo;
  if (undo) runUndo(undo).catch((e: unknown) => undoFailed(e, undo));
}

/** Does z still run this undo? */
export function zHolds(s: Pick<SnackState, "undo">, undo: Undo | undefined): boolean {
  return !!undo && s.undo === undo && undo.state === "ready";
}

/** Tests: a clean slate. */
export function resetSnacks(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
  displaced.clear();
  useSnack.setState({ current: null, last: null, countdown: { elapsed: 0, since: null }, paused: [], undo: null, inset: 0 });
}
