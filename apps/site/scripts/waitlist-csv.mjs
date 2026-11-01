// `pnpm waitlist:csv [--platform=linux|windows|mac|mac-intel] [--out=file.csv] [--preview | --local]` (plan 97):
// the waitlist from D1 to a CSV. Production by default; --preview reads the preview Worker's database, --local the
// one `pnpm --filter @terno/site preview` uses. The file holds people's emails: it is git-ignored, keep it private
// and delete it once the launch email is out.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rowsFromWrangler, toCsv, waitlistQuery } from "../src/waitlist-csv.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

const platform = arg("platform");
const preview = process.argv.includes("--preview");
const local = process.argv.includes("--local");
let query;
try {
  query = waitlistQuery(platform);
} catch (e) {
  fail(e.message);
}

const database = preview ? "terno-site-waitlist-preview" : "terno-site-waitlist";
const where = local ? ["--local"] : ["--remote", "--env", preview ? "preview" : ""];
const run = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", ...where, "--json", "--command", query], { cwd: site, encoding: "utf8" });
if (run.status !== 0) fail(`wrangler couldn't read ${local ? "the local database" : database}:\n${(run.stderr || run.stdout).trim()}\n(signed in? \`pnpm --filter @terno/site exec wrangler login\`)`);

let rows;
try {
  rows = rowsFromWrangler(run.stdout);
} catch (e) {
  fail(e.message);
}

// relative to where the command was typed (pnpm runs scripts inside apps/site)
const day = new Date().toISOString().slice(0, 10);
const out = resolve(process.env.INIT_CWD ?? process.cwd(), arg("out") ?? `waitlist-${platform ?? "all"}-${day}${local ? "-local" : preview ? "-preview" : ""}.csv`);
writeFileSync(out, toCsv(rows), { mode: 0o600 });
const counts = Object.entries(rows.reduce((m, r) => ((m[r.platform] = (m[r.platform] ?? 0) + 1), m), {})).map(([p, n]) => `${p} ${n}`);
console.log(`✓ ${rows.length} ${rows.length === 1 ? "person" : "people"}${counts.length ? ` (${counts.join(", ")})` : ""} → ${out}`);
