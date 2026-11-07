// One round of the UI rating (plan 158): freeze this commit's build, capture every style, and have Claude and Codex rate each
// one in a clean room. A rater starts in an empty, randomly named folder outside the repo, in a new session that keeps nothing:
// no project instructions, no memory, no earlier round, no idea how many rounds there were or what changed.
//   node scripts/ui-rating/rate.mjs --out <dir> [--designs lumen,macos] [--raters claude,codex] [--parallel 4] [--allow-dirty]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGNS, RATERS, reportProblems } from "./gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };

const out = flag("out");
if (!out) throw new Error("usage: rate.mjs --out <dir> [--designs a,b] [--raters claude,codex] [--parallel n] [--allow-dirty]");
const designs = flag("designs", DESIGNS.join(",")).split(",");
const raters = flag("raters", RATERS.join(",")).split(",");
const parallel = Number(flag("parallel", "4"));
const NAMES = { lumen: "Lumen", atelier: "Atelier", macos: "macOS", graphite: "Graphite" };
const HOURS = 3_600_000;

// a score belongs to a commit
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo }).toString().trim();
if (dirty && !process.argv.includes("--allow-dirty")) throw new Error("commit first: a round rates one commit");
const sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: repo }).toString().trim() + (dirty ? "-dirty" : "");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "round.json"), JSON.stringify({ sha, at: new Date().toISOString(), designs, raters }, null, 2));

/** The build the whole round rates, apart from the checkout. Electron takes the app's root from the package.json above main.cjs. */
function freeze() {
  const frozen = join(out, "build");
  rmSync(frozen, { recursive: true, force: true });
  execFileSync("pnpm", ["--filter", "@terno/web", "build"], { cwd: repo, stdio: "ignore" });
  execFileSync(process.execPath, ["apps/desktop/scripts/build.mjs"], { cwd: repo, stdio: "ignore" });
  mkdirSync(frozen, { recursive: true });
  cpSync(join(repo, "apps/desktop/dist"), join(frozen, "dist"), { recursive: true });
  cpSync(join(repo, "apps/desktop/package.json"), join(frozen, "package.json"));
  cpSync(join(repo, "apps/desktop/resources"), join(frozen, "resources"), { recursive: true });
  return join(frozen, "dist");
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
      if (log) writeFileSync(log, Buffer.concat(chunks));
      resolve(code);
    });
  });
}

/** The rater's world: nothing of the session that started it, nothing of the repo but what the harness needs to run. */
function cleanEnv(build) {
  const env = { ...process.env, UI_RATING_BUILD: build };
  for (const k of Object.keys(env)) if (/^(CLAUDE|T3|CODEX_SESSION|ELECTRON_RUN_AS_NODE|ANTHROPIC_MODEL)/.test(k)) delete env[k];
  return env;
}

const PROMPT = "Read brief.md in this folder and do exactly what it says. Work alone, don't ask questions.";

const COMMANDS = {
  claude: (room) => ({ cmd: "claude", args: ["-p", PROMPT, "--model", "claude-opus-5-5", "--effort", "high", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "bypassPermissions"], cwd: room }),
  codex: (room) => ({ cmd: "codex", args: ["exec", "--ephemeral", "--skip-git-repo-check", "-C", room, "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-c", "project_doc_max_bytes=0", "--dangerously-bypass-approvals-and-sandbox", "-"], cwd: room, stdin: PROMPT }),
};

function brief(design) {
  const full = design === "lumen";
  const hands = full
    ? "Try at least: moving through the list by keyboard, opening and leaving a conversation, replying and putting the draft away, a new message, search and getting out of it, the palette, selecting and archiving with undo, the right-click menu, a smaller window (about 1100x700)."
    : "Most flows of this app are shared between its styles and are rated elsewhere. Here, try the things this style changes: where new message lives, the list header, search, the quick filters, the list row, category suggestions in the sidebar, the reader's header and the reply controls in its toolbar, in light and dark. Judge contrast with particular care, in both modes.";
  return readFileSync(join(here, "brief.md"), "utf8").replaceAll("{{DESIGN}}", NAMES[design]).replaceAll("{{DESIGN_ID}}", design).replace("{{HANDS_ON}}", hands);
}

async function rate(design, rater, shots, build) {
  const dest = join(out, design);
  const room = mkdtempSync("/tmp/rate-");
  try {
    cpSync(shots, join(room, "shots"), { recursive: true });
    mkdirSync(join(room, "probes"));
    writeFileSync(join(room, "brief.md"), brief(design));
    writeFileSync(join(room, "harness.mjs"), `export * from ${JSON.stringify(join(here, "harness.mjs"))};\n`);
    writeFileSync(join(room, "capture-example.mjs"), readFileSync(join(here, "capture.mjs"), "utf8").replace('"./harness.mjs"', JSON.stringify(join(room, "harness.mjs"))));
    const { cmd, args, cwd, stdin } = COMMANDS[rater](room);
    const started = Date.now();
    await run(cmd, args, { cwd, stdin, env: cleanEnv(build), log: join(dest, `${rater}.log`), timeout: 1.5 * HOURS });
    const file = join(room, "report.json");
    let problems = ["no report.json"];
    if (existsSync(file)) {
      try { problems = reportProblems(JSON.parse(readFileSync(file, "utf8"))); } catch (e) { problems = [`bad JSON: ${e.message}`]; }
    }
    console.log(`${design}/${rater}: ${problems.length ? `${problems.length} problems: ${problems.slice(0, 3).join("; ")}` : "ok"} (${Math.round((Date.now() - started) / 60_000)} min)`);
    if (existsSync(file)) cpSync(file, join(dest, `${rater}.json`));
    if (existsSync(join(room, "report.md"))) cpSync(join(room, "report.md"), join(dest, `${rater}.md`));
    cpSync(join(room, "probes"), join(dest, `${rater}-probes`), { recursive: true });
  } finally { rmSync(room, { recursive: true, force: true }); }
}

const build = freeze();
console.log(`round ${sha}: build frozen`);
for (const design of designs) {
  const shots = join(out, design, "shots");
  if (existsSync(shots)) continue;
  const code = await run(process.execPath, [join(here, "capture.mjs"), design, shots], { env: { ...process.env, UI_RATING_BUILD: build }, log: join(out, `capture-${design}.log`), timeout: 0.2 * HOURS });
  if (code !== 0) throw new Error(`capture ${design} failed: ${readFileSync(join(out, `capture-${design}.log`), "utf8").slice(-800)}`);
  console.log(`${design}: captured`);
}

const jobs = designs.flatMap((design) => raters.map((rater) => () => rate(design, rater, join(out, design, "shots"), build)));
await Promise.all(Array.from({ length: parallel }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await job(); }));
console.log("round finished");
