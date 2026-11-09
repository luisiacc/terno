// One round of the UI rating (plan 158): freeze this commit's build, capture every style, and have Claude and Codex rate each
// one in a clean room. A rater starts in an empty, randomly named folder outside the repo, in a new session that keeps nothing:
// no project instructions, no memory, no earlier round, no idea how many rounds there were or what changed.
// `--screens ai` rates plan 161's AI screens with their own brief, on Pro's real models (keys from the owner's .env,
// keys.mjs), or on the local stand-in with `--ai stub`.
//   node scripts/ui-rating/rate.mjs --out <dir> [--screens everyday|ai] [--ai real|stub] [--designs lumen,macos] [--raters claude,codex] [--parallel 6] [--allow-dirty]
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGNS, RATERS, reportProblems } from "./gate.mjs";
import { copyRedacted, envFile, guardOutput, PRO_ROUTING, readKeys, writeRedacted } from "./keys.mjs";
import { aiFlag, SETS, screensFlag, shotFiles } from "./sets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };

const out = flag("out");
if (!out) throw new Error("usage: rate.mjs --out <dir> [--screens everyday|ai] [--ai real|stub] [--designs a,b] [--raters claude,codex] [--parallel n] [--allow-dirty]");
const set = screensFlag(process.argv);
const ai = set === "ai" ? aiFlag(process.argv) : null;
/**
 * Real models: the keys are read here only to fail early and to redact. This process never passes them on: each
 * capture's harness reads the same file and hands them to its Electron alone. Every log, report and probe this round
 * writes goes through redaction (keys.mjs), and so does this process's own output.
 */
const keys = ai === "real" ? readKeys(envFile()) : null;
const secrets = keys?.secrets ?? [];
if (keys) guardOutput(secrets);
const designs = flag("designs", DESIGNS.join(",")).split(",");
const raters = flag("raters", RATERS.join(",")).split(",");
const parallel = Number(flag("parallel", "6"));
const NAMES = { lumen: "Lumen", atelier: "Atelier", macos: "macOS", graphite: "Graphite" };
const HOURS = 3_600_000;

// a score belongs to a commit
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trim();
if (dirty && !process.argv.includes("--allow-dirty")) throw new Error("commit first: a round rates one commit");
const sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: repo }).toString().trim() + (dirty ? "-dirty" : "");
// a round is new, whole and kept: its folder can't hold another round's shots or reports
if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} already holds a round: every round gets its own folder`);
mkdirSync(out, { recursive: true });
/**
 * What this round rates, frozen before anything runs (plan 161, revision 11): the set, its screens, every shot the
 * capture must write, and the hashes of what decides them. gate.mjs checks reports against this, never against a
 * report's own list. The demo mailbox comes from its generator and seed: no AI screen adds mail of its own.
 */
const hash = (...files) => createHash("sha256").update(files.map((f) => readFileSync(join(repo, f))).join("\0")).digest("hex").slice(0, 16);
/**
 * Who answers (plan 161): the stub, or Pro's providers and the model each task runs on. Real rounds aren't byte-comparable
 * with stub rounds, or with each other at other models; each capture adds what it reached, saw and spent (`runs`).
 */
const round = {
  sha,
  at: new Date().toISOString(),
  designs,
  raters,
  set,
  screens: SETS[set].screens,
  shots: shotFiles(set),
  hashes: {
    brief: hash(`scripts/ui-rating/${SETS[set].brief}`),
    capture: hash("scripts/ui-rating/capture.mjs", "scripts/ui-rating/harness.mjs", "scripts/ui-rating/sets.mjs", "scripts/ui-rating/keys.mjs"),
    ...(ai === "stub" ? { stub: hash("scripts/ui-rating/model-stub.mjs") } : {}),
    demo: hash("packages/mock-data/src/generate.ts", "packages/mock-data/src/banks.ts", "packages/backend/src/demo.ts"),
  },
  ...(ai === "real" ? { ai: { models: "real", providers: keys.providers, hosts: keys.hosts, routing: PRO_ROUTING, runs: {} } } : ai === "stub" ? { ai: { models: "stub" } } : {}),
};
const writeRound = () => writeRedacted(join(out, "round.json"), JSON.stringify(round, null, 2), secrets);
writeRound();

/**
 * What the whole round runs, frozen now and apart from the checkout and the round's folder: the build, Electron, Playwright,
 * the harness and the brief. Electron takes the app's root from the package.json above main.cjs.
 */
function freeze() {
  const runtime = mkdtempSync("/tmp/rt-");
  const app = join(runtime, "app");
  execFileSync("pnpm", ["--filter", "@terno/web", "build"], { cwd: repo, stdio: "ignore" });
  execFileSync(process.execPath, ["apps/desktop/scripts/build.mjs"], { cwd: repo, stdio: "ignore" });
  mkdirSync(app, { recursive: true });
  cpSync(join(repo, "apps/desktop/dist"), join(app, "dist"), { recursive: true });
  cpSync(join(repo, "apps/desktop/package.json"), join(app, "package.json"));
  cpSync(join(repo, "apps/desktop/resources"), join(app, "resources"), { recursive: true });
  execFileSync("cp", ["-cR", join(repo, "apps/desktop/node_modules/electron/dist/Electron.app"), join(runtime, "Electron.app")]);
  const pnpmDir = join(repo, "node_modules/.pnpm");
  const core = readdirSync(pnpmDir).find((d) => d.startsWith("playwright-core@"));
  cpSync(join(pnpmDir, core, "node_modules/playwright-core"), join(app, "node_modules/playwright-core"), { recursive: true, dereference: true });
  for (const f of ["harness.mjs", "capture.mjs", "sets.mjs", "model-stub.mjs", "keys.mjs", "brief.md", "brief-ai.md"]) cpSync(join(here, f), join(runtime, f));
  return runtime;
}

function run(cmd, args, { cwd, env, stdin, log, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    if (stdin !== undefined) child.stdin.end(stdin);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      // a child's output can't carry a key into the round (keys.mjs)
      if (log) writeRedacted(log, Buffer.concat(chunks), secrets);
      resolve(code);
    });
  });
}

/**
 * The rater's world: only what a shell needs, so nothing of the session that started it comes along. No key: a rater's
 * harness reads the owner's .env itself (keys.mjs), at its default path or the one TERNO_RATING_ENV names.
 */
function cleanEnv(runtime) {
  const env = { UI_RATING_RUNTIME: runtime };
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "TERNO_RATING_ENV"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const PROMPT = "Read brief.md in this folder and do exactly what it says. Work alone, don't ask questions.";

const COMMANDS = {
  claude: (room) => ({ cmd: "claude", args: ["-p", PROMPT, "--model", "claude-opus-5-5", "--effort", "high", "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "bypassPermissions"], cwd: room }),
  codex: (room) => ({ cmd: "codex", args: ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-C", room, "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-c", "project_doc_max_bytes=0", "--dangerously-bypass-approvals-and-sandbox", "-"], cwd: room, stdin: PROMPT }),
};

/** What a rater tries by hand: the whole set in Lumen, the default; in the other styles, what the style draws differently. */
const HANDS_ON = {
  everyday: (full) => full
    ? "Try at least: moving through the list by keyboard, opening and leaving a conversation, replying and putting the draft away, a new message, search and getting out of it, the palette, selecting and archiving with undo, the right-click menu, a smaller window (about 1100x700)."
    : "Try at least the things this style changes: where new message lives, the list header, search, the quick filters, the list row, category suggestions in the sidebar, the reader's header and the reply controls in its toolbar, in light and dark, plus any other flow you need to score a cell honestly. Judge contrast with particular care, in both modes.",
  ai: (full) => full
    ? "Try at least, with `ai: true`: summarize a conversation from its toolbar; in a reply, press ⌘J, give an instruction, then try the strip's actions and Undo; press ⇧⌘K, ask about your mail, open a source and come back; describe an action in the same place, check its preview, Apply, then Undo; open Today and its digest; send someone a question and open it in Sent to see the follow-up, then Nudge (nothing sends); open a conversation waiting for your reply and Use the reply prepared for it; create a filter with AI in Rules; look at Settings → AI → Writing style; and a smaller window (about 1100x700)."
    : "Try at least, with `ai: true`, the AI surfaces as this style draws them: the summary card, the ⌘J row and its strip, the Ask panel, an action's preview and its undo, Today and the digest, the follow-up line and the prepared reply, in light and dark, plus any other flow you need to score a cell honestly. Judge contrast with particular care, in both modes.",
};

function brief(design, runtime) {
  const hands = HANDS_ON[set](design === "lumen") + (design === "macos" ? " This style's sidebar is translucent on the real window; the screenshots flatten it onto the window's background." : "");
  return readFileSync(join(runtime, SETS[set].brief), "utf8").replaceAll("{{DESIGN}}", NAMES[design]).replaceAll("{{DESIGN_ID}}", design).replace("{{HANDS_ON}}", hands);
}

async function rate(design, rater, shots, runtime) {
  const dest = join(out, design);
  const room = mkdtempSync("/tmp/rate-");
  try {
    cpSync(shots, join(room, "shots"), { recursive: true });
    mkdirSync(join(room, "probes"));
    writeRedacted(join(room, "brief.md"), brief(design, runtime), secrets);
    // the harness and what it and the example import
    for (const f of ["harness.mjs", "model-stub.mjs", "sets.mjs", "keys.mjs"]) cpSync(join(runtime, f), join(room, f));
    cpSync(join(runtime, "capture.mjs"), join(room, "capture-example.mjs"));
    const { cmd, args, cwd, stdin } = COMMANDS[rater](room);
    const started = Date.now();
    const code = await run(cmd, args, { cwd, stdin, env: cleanEnv(runtime), log: join(dest, `${rater}.log`), timeout: 1.5 * HOURS });
    const file = join(room, "report.json");
    let problems = [`no report.json (exit ${code})`];
    if (existsSync(file)) {
      try { problems = reportProblems(JSON.parse(readFileSync(file, "utf8")), SETS[set].screens); } catch (e) { problems = [`bad JSON: ${e.message}`]; }
    }
    console.log(`${design}/${rater}: ${problems.length ? `${problems.length} problems: ${problems.slice(0, 3).join("; ")}` : "ok"} (${Math.round((Date.now() - started) / 60_000)} min)`);
    // what leaves the room is redacted on the way: a rater can read the owner's .env, and the brief can't make sure it doesn't
    if (existsSync(file)) copyRedacted(file, join(dest, `${rater}.json`), secrets);
    if (existsSync(join(room, "report.md"))) copyRedacted(join(room, "report.md"), join(dest, `${rater}.md`), secrets);
    copyRedacted(join(room, "probes"), join(dest, `${rater}-probes`), secrets);
  } finally { rmSync(room, { recursive: true, force: true }); }
}

const runtime = freeze();
console.log(`round ${sha}: frozen`);
try {
  for (const design of designs) {
    // real models take minutes a state, and a step the model decides may be tried again
    const code = await run(process.execPath, [join(runtime, "capture.mjs"), design, join(out, design, "shots"), "--screens", set, ...(ai ? ["--ai", ai] : [])], { env: cleanEnv(runtime), log: join(out, `capture-${design}.log`), timeout: (ai === "real" ? 1.5 : 0.2) * HOURS });
    const captured = readFileSync(join(out, `capture-${design}.log`), "utf8");
    if (code !== 0) throw new Error(`capture ${design} failed: ${captured.slice(-800)}`);
    if (ai === "real") {
      round.ai.runs[design] = captured.split("\n").filter((l) => l.startsWith("AI_RUN ")).map((l) => JSON.parse(l.slice(7)));
      writeRound();
    }
    const missing = shotFiles(set).filter((f) => !existsSync(join(out, design, "shots", f)));
    if (missing.length) throw new Error(`capture ${design} is missing ${missing.join(", ")}`);
    console.log(`${design}: captured`);
  }
  const jobs = designs.flatMap((design) => raters.map((rater) => () => rate(design, rater, join(out, design, "shots"), runtime)));
  await Promise.all(Array.from({ length: parallel }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await job(); }));
} finally { rmSync(runtime, { recursive: true, force: true }); }
console.log("round finished");
