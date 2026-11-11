/**
 * Plan 167: `pnpm dev:demo-ai`, the demo mailbox with every AI feature already holding something, on real models. What
 * `dev.mjs` decides before anything starts, kept pure so it's tested: the arguments, where the keys come from, the
 * environment, and which preparation steps a launch still has to run. The steps themselves drive the app
 * (`scripts/demo-ai-prepare.mjs`).
 */
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEMO_AI_PROFILE = "Terno-dev-demo-ai";
/** The rating's instant (plan 161's AI_NOW): half an hour after the demo mailbox's newest mail, on every launch. */
export const DEMO_AI_NOW = Date.UTC(2026, 9, 22, 16, 0);
/** Dev mode's names (plan 146's DEV_AI_ENV): the only ones read from a .env. */
export const DEMO_AI_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY"] as const;
/** Pro drafts on one and summarizes on the other; JEV (smart categories) is off in the demo. */
export const REQUIRED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** In the order they run: each needs what came before it (AI on first, the digest before Today's rows are read). */
export const DEMO_AI_STEPS = ["ai-on", "digest", "conversations", "followups", "ask", "rule", "style"] as const;
export type DemoAiStep = (typeof DEMO_AI_STEPS)[number];
export const MARKER_FILE = "demo-ai.json";
/** A marker from another version of the steps starts the preparation over. */
export const MARKER_VERSION = 1;

export interface DemoAiArgs {
  /** the profile to the Trash first, prepared again */
  fresh: boolean;
}

const ACCEPTED = ["--demo-ai", "--fresh", "--cleandb"];

/** `--fresh` (or dev.mjs's `--cleandb`, the same here); anything else is refused, so a typo isn't a silent no-op. */
export function demoAiArgs(argv: readonly string[]): DemoAiArgs {
  const flags = argv.filter((a) => a.startsWith("-"));
  const unknown = flags.filter((a) => !ACCEPTED.includes(a));
  if (unknown.length) throw new Error(`dev:demo-ai doesn't take ${unknown.join(", ")}: it takes --fresh (start over)`);
  return { fresh: flags.includes("--fresh") || flags.includes("--cleandb") };
}

/**
 * Where the keys may be, in order: this checkout's .env, then the main checkout's (a worktree has none of its own; git's
 * common dir is the main checkout's .git). Duplicates once.
 */
export function keyFiles(repo: string, gitCommonDir: string | null): string[] {
  const files = [join(repo, ".env")];
  if (gitCommonDir) files.push(join(dirname(isAbsolute(gitCommonDir) ? gitCommonDir : resolve(repo, gitCommonDir)), ".env"));
  return [...new Set(files)];
}

/** Dev mode's names from a .env's text, and nothing else in it. */
export function devKeysIn(text: string): Partial<Record<(typeof DEMO_AI_KEYS)[number], string>> {
  const out: Partial<Record<(typeof DEMO_AI_KEYS)[number], string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !(DEMO_AI_KEYS as readonly string[]).includes(m[1]!)) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) out[m[1] as (typeof DEMO_AI_KEYS)[number]] = value;
  }
  return out;
}

/**
 * The keys this launch runs on: the shell's win, then each file in turn fills what's still missing. `from` names where
 * each came from (a path or "the shell"), never a value.
 */
export function resolveKeys(shell: Record<string, string | undefined>, files: readonly { path: string; text: string | null }[]): { keys: Record<string, string>; from: Record<string, string>; missing: string[] } {
  const keys: Record<string, string> = {};
  const from: Record<string, string> = {};
  for (const name of DEMO_AI_KEYS) {
    const value = shell[name]?.trim();
    if (value) { keys[name] = value; from[name] = "the shell"; }
  }
  for (const file of files) {
    if (file.text === null) continue;
    for (const [name, value] of Object.entries(devKeysIn(file.text))) if (!keys[name]) { keys[name] = value; from[name] = file.path; }
  }
  return { keys, from, missing: REQUIRED_KEYS.filter((k) => !keys[k]) };
}

/** What to say when a key is missing: the names and the places looked, never a value. */
export function missingKeysMessage(missing: readonly string[], files: readonly string[]): string {
  return [
    `[demo-ai] AI needs ${missing.join(" and ")} (Dev mode's Pro routing, plan 146). Looked in your shell and in:`,
    ...files.map((f) => `  ${f}`),
    "Add them to the repo's .env (git-ignored) and run pnpm dev:demo-ai again.",
  ].join("\n");
}

/**
 * Electron's environment: the demo mailbox, the fixed clock, UTC, and the keys. The preparation launch also runs behind
 * your windows (TERNO_TEST_BACKGROUND); the window you use doesn't unless the shell sets it. Every rating-only hook the caller might have set is
 * dropped: this is a dev build on a dev server, Dev mode comes from that.
 */
export function demoAiEnv(o: { base: Record<string, string | undefined>; profile: string; keys: Record<string, string>; devUrl: string; background: boolean; now?: number }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.base)) if (v !== undefined) env[k] = v;
  for (const k of ["ELECTRON_RUN_AS_NODE", "TERNO_TEST_BACKGROUND", "TERNO_TEST_LANGUAGES", "TERNO_TEST_DEV_AI", "TERNO_TEST_NET_LOG", "TERNO_TEST_NOW", ...DEMO_AI_KEYS]) delete env[k];
  Object.assign(env, o.keys, { TERNO_DEMO: "1", TERNO_USER_DATA: o.profile, TERNO_DEV_URL: o.devUrl, TERNO_TEST_NOW: String(o.now ?? DEMO_AI_NOW), TZ: "UTC" });
  // the preparation always; your window only if your shell asked (a scripted check that mustn't take focus)
  if (o.background || o.base.TERNO_TEST_BACKGROUND === "1") env.TERNO_TEST_BACKGROUND = "1";
  // the preparation reads the app's words to know a step is done: in English whatever the Mac's language (only the
  // system languages it sees are pinned, the language setting stays as it is)
  if (o.background) env.TERNO_TEST_LANGUAGES = "en-US";
  return env;
}

export interface DemoAiMarker {
  version: number;
  /** each step that finished, with when (the real clock) */
  done: Partial<Record<DemoAiStep, string>>;
  /** what a step that didn't finish said, kept for the next launch's log */
  failed?: Partial<Record<DemoAiStep, string>>;
  /** what a step already made, one item at a time (Ask's questions, the rule): a step run again doesn't make it twice */
  progress?: Partial<Record<DemoAiStep, string[]>>;
  /** how many launches tried each step (MAX_ATTEMPTS) */
  attempts?: Partial<Record<DemoAiStep, number>>;
  /**
   * The demo's clock when the preparation ended (epoch ms). Later launches start there, not back at 16:00: what it made
   * (the follow-up switch's time, an answer) is never ahead of the clock.
   */
  clock?: number;
}

/** Where a launch's clock starts: the demo's 16:00, or just after the preparation if that ended later. */
export function demoAiClock(marker: DemoAiMarker | null): number {
  const after = marker?.clock;
  return typeof after === "number" && Number.isFinite(after) && after > DEMO_AI_NOW ? after : DEMO_AI_NOW;
}

/**
 * Plan 167: TERNO_USER_DATA may move the profile, but never onto anything that isn't this demo's: the preparation turns
 * cloud AI on and --fresh puts the folder in the Trash. Checked before anything opens or renames a file in it. A real
 * profile's folder (Terno, Unica, without -dev, in Application Support: the only place the app keeps one) is refused,
 * and so is any folder with something in it but no marker of ours (another dev profile, Application Support itself); a
 * folder that doesn't exist yet or is empty is fine. Elsewhere the name says nothing: /tmp/terno-demo-ai is fine.
 * `entries`: the folder's names, or null when there's no folder.
 */
export function demoAiProfileProblem(o: { path: string; entries: readonly string[] | null }): string | null {
  const parts = o.path.replace(/\/+$/, "").split("/");
  const name = parts.at(-1) ?? "";
  const inAppSupport = /^application support$/i.test(parts.at(-2) ?? "");
  if (inAppSupport && (/^(Terno|Unica|Única)( .*)?$/i.test(name) || /^(Terno|Unica|Única)-(?!dev)/i.test(name))) return `${o.path} looks like a real Terno profile: dev:demo-ai uses its own (unset TERNO_USER_DATA)`;
  const entries = (o.entries ?? []).filter((e) => e !== ".DS_Store");
  if (entries.length && !entries.includes(MARKER_FILE)) return `${o.path} holds something that isn't the AI demo's: dev:demo-ai won't turn AI on in it or clear it (unset TERNO_USER_DATA, or point it at a new folder)`;
  return null;
}

/** A step that still has something missing runs again on the next launch, up to this many tries; then what's there stays. */
export const MAX_ATTEMPTS = 3;

/** Ask: a question counts once every turn finished with an answer of some kind (not_found is the model's answer too). */
export function askFinished(statuses: readonly (string | null)[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === "answered" || s === "partial" || s === "not_found");
}

/**
 * A conversation is done when its summary is ready (or it offers none) and its reply is ready or the model decided it
 * needs none ("none": the card never showed). An error or a timeout leaves it for the next launch.
 */
export function conversationDone(o: { summary: "ready" | "none" | "error" | "timeout"; reply: "ready" | "none" | "unfinished" }): boolean {
  return (o.summary === "ready" || o.summary === "none") && o.reply !== "unfinished";
}

/** The window Reply ready answers within (`@terno/core`'s WAITING_WINDOW_MS): older waits get none. */
const WAITING_WINDOW_MS = 30 * 86_400_000;

/**
 * Reply ready on a conversation, settled or not. The card shows only while a reply comes, so its absence alone says
 * nothing; what the app stored for the thread decides (read, never written): its row says ready, skipped (the model said
 * no reply is needed) or failed. Without a row, a conversation that doesn't wait for your reply (or waited too long) gets
 * none; one that does is unfinished, and tried again next launch.
 */
export function replyOutcome(o: { cardReady: boolean; stored: string | null; waitingSince: number | null; now: number }): "ready" | "none" | "unfinished" {
  if (o.cardReady || o.stored === "ready" || o.stored === "used" || o.stored === "dismissed") return "ready";
  if (o.stored === "skipped") return "none";
  if (o.stored === "failed") return "unfinished";
  if (o.waitingSince === null || o.now - o.waitingSince > WAITING_WINDOW_MS) return "none";
  return "unfinished";
}

/**
 * The conversations step's settle: whether to keep waiting for a reply it left. Only one that was writing goes on (its
 * first words were in); one left before them was stopped by leaving (the backend's `replies.leave`) and stores nothing
 * more, so what's stored is all there is.
 */
export function replyStillComing(o: { reply: "ready" | "none" | "unfinished"; stored: string | null; writing: boolean; waited: number; limit: number }): boolean {
  return o.reply === "unfinished" && o.stored !== "failed" && o.writing && o.waited <= o.limit;
}

/** What a step that left things missing does: fail (and run again next launch), or, on its last try, keep what's there. */
export function partialVerdict(missing: readonly string[], attempt: number): "done" | "again" | "keep" {
  return missing.length === 0 ? "done" : attempt >= MAX_ATTEMPTS ? "keep" : "again";
}

/** The marker's text, or null when it's missing, unreadable or from another version: all of those start over. */
export function readMarker(text: string | null): DemoAiMarker | null {
  if (text === null) return null;
  try {
    const m = JSON.parse(text) as DemoAiMarker;
    return m && m.version === MARKER_VERSION && typeof m.done === "object" && m.done !== null ? m : null;
  } catch {
    return null;
  }
}

/** The steps this launch runs: all on a fresh profile, none once every one is done, else the ones still missing. */
export function stepsToRun(marker: DemoAiMarker | null, args: DemoAiArgs): DemoAiStep[] {
  if (args.fresh || !marker) return [...DEMO_AI_STEPS];
  return DEMO_AI_STEPS.filter((s) => !marker.done[s]);
}
