// Plan 161: the AI rating on real models. The keys come from one file, the owner's .env, read at launch and passed only to
// the Electron process the harness starts. Nothing here prints, logs or writes a value: what leaves this module is the
// keys themselves (for that one env), the names of the providers they run, and redaction.
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

/** The owner's file, by default; a worktree or the frozen runtime finds it by this path, or by TERNO_RATING_ENV. */
export const DEFAULT_ENV_FILE = "/Users/Luis/projects/emailclient/.env";
export const envFile = (env = process.env) => env.TERNO_RATING_ENV || DEFAULT_ENV_FILE;

/**
 * Pro's providers (plan 146's DEV_AI_ENV) and the one host each key may reach (`@terno/ai`'s defaultBaseURL; a test holds
 * both). Anthropic and OpenAI are required: Pro drafts on one and summarizes on the other. JEV runs smart categories,
 * off in the demo, so it's passed when the file has it. Nothing else in the file is read (GROQ_API_KEY isn't Pro's).
 */
export const PROVIDERS = {
  anthropic: { env: "ANTHROPIC_API_KEY", host: "api.anthropic.com", required: true },
  openai: { env: "OPENAI_API_KEY", host: "api.openai.com", required: true },
  jev: { env: "JEV_API_KEY", host: "api.typesafe.ai", required: false },
};

/**
 * What runs each task under Pro's routing with all three keys (AiService.targetFor over withDevAi; a test holds it to
 * `@terno/core`'s and `@terno/ai`'s constants). Recorded in round.json: real rounds compare only at the same models.
 */
export const PRO_ROUTING = {
  summary: "openai/gpt-6-luna",
  writing: "anthropic/claude-sonnet-5-5",
  reply: "anthropic/claude-sonnet-5-5",
  replyCheck: "anthropic/claude-haiku-5-5",
  ask: "anthropic/claude-sonnet-5-5",
  askPlan: "anthropic/claude-haiku-5-5",
  followup: "anthropic/claude-haiku-5-5",
  digest: "anthropic/claude-haiku-5-5",
  filter: "anthropic/claude-opus-5-5",
  intent: "anthropic/claude-haiku-5-5",
  voice: "anthropic/claude-sonnet-5-5",
  categorize: "jev/jev-latest",
};

/**
 * The keys Pro runs on, from the file: `{ env, providers, hosts, secrets }`. `env` goes into the Electron process's
 * environment and nowhere else; `secrets` is for redaction. An error names the file and the variables, never a value.
 */
export function readKeys(file = envFile()) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { throw new Error(`the AI rating's keys aren't there: no file at ${file} (TERNO_RATING_ENV names another)`); }
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) found[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const env = {};
  const providers = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const value = found[p.env]?.trim();
    if (value) { env[p.env] = value; providers.push(id); } else if (p.required) throw new Error(`${file} has no ${p.env}: the AI rating needs it`);
  }
  return { env, providers, hosts: providers.map((id) => PROVIDERS[id].host), secrets: Object.values(env) };
}

/** Shapes of provider keys, for text that may hold a key this run didn't load (a rater's copy of another file). */
const SHAPES = [/sk-ant-[A-Za-z0-9_-]{16,}/g, /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g, /gsk_[A-Za-z0-9]{24,}/g];
export const REDACTED = "[redacted key]";

/** Text with every loaded key, and anything shaped like one, replaced. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(REDACTED);
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** Whether a buffer or string holds a loaded key. */
export const holdsKey = (data, secrets) => secrets.some((s) => s && s.length >= 8 && Buffer.from(data).includes(s));

const guarded = { secrets: new Set(), installed: false };

/**
 * From here on this process's stdout and stderr can't carry a key: every write is redacted (console.log and .error go
 * through them). Installed once; later calls add keys. A key split across two writes would pass, and nothing here
 * writes one: this is the second line, after not printing them at all.
 */
export function guardOutput(secrets) {
  for (const s of secrets) guarded.secrets.add(s);
  if (guarded.installed) return;
  guarded.installed = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(typeof chunk === "string" || Buffer.isBuffer(chunk) ? redact(chunk, [...guarded.secrets]) : chunk, ...rest);
  }
}

const TEXT = new Set([".md", ".json", ".txt", ".log", ".mjs", ".js", ".cjs", ".ts", ".html", ".csv", ".yaml", ".yml", ".sh", ""]);

/** A file written for the round, redacted on the way. */
export function writeRedacted(file, data, secrets) {
  writeFileSync(file, redact(Buffer.isBuffer(data) ? data.toString("utf8") : data, secrets));
}

/** cpSync, with every text file redacted on the way (a rater's report and probes leave the room through here). */
export function copyRedacted(src, dest, secrets) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyRedacted(join(src, name), join(dest, name), secrets);
    return;
  }
  if (TEXT.has(extname(src).toLowerCase())) writeRedacted(dest, readFileSync(src), secrets);
  else cpSync(src, dest);
}

/** Every file under `dir` that holds a loaded key: the proof, after a run, that nothing it wrote does. */
export function filesHoldingKeys(dir, secrets) {
  const found = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && holdsKey(readFileSync(path), secrets)) found.push(path);
    }
  };
  walk(dir);
  return found;
}
