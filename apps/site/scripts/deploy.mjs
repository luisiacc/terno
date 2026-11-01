// `pnpm deploy:site` (production: terno.app) and `pnpm deploy:site:preview` (terno-site-preview on workers.dev,
// its own database, noindex). Plan 97. The steps and their order are src/deploy-steps.mjs: tests, build, the D1
// database (created on the first deploy), its migrations, then the Worker; a failing step stops the rest.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploySteps, runSteps } from "../src/deploy-steps.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(site, "..", "..");
const preview = process.argv.includes("--preview");

const sh = (cmd, args, { cwd = site, capture = false } = {}) => {
  console.log(`\n› ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (capture && r.stdout) process.stdout.write(r.stdout);
  return { ok: r.status === 0, stdout: r.stdout ?? "" };
};

const result = await runSteps(deploySteps({ preview }), {
  exec: async (s) => sh(s.cmd, s.args, { cwd: s.cwd === "repo" ? repo : site, capture: s.capture }),
  ensureDatabase: async (name) => {
    const find = () => {
      const list = spawnSync("pnpm", ["exec", "wrangler", "d1", "list", "--json"], { cwd: site, encoding: "utf8" });
      return list.status === 0 ? JSON.parse(list.stdout.slice(list.stdout.indexOf("["))).find((d) => d.name === name) : undefined;
    };
    let db = find();
    if (!db && sh("pnpm", ["exec", "wrangler", "d1", "create", name]).ok) db = find();
    if (!db?.uuid) return false;
    // the id goes into wrangler.jsonc once (ids aren't secret), so migrations and the deploy name the same database
    const config = join(site, "wrangler.jsonc");
    const text = readFileSync(config, "utf8");
    const named = `"database_name": "${name}"`;
    if (!text.includes(`${named}, "database_id"`)) {
      writeFileSync(config, text.replace(named, `${named}, "database_id": "${db.uuid}"`));
      console.log(`\n! wrote the id of ${name} into apps/site/wrangler.jsonc: commit it`);
    }
    return true;
  },
});
if (!result.ok) {
  console.error(`\n✗ ${result.failed}: ${result.hint}. Nothing after it ran.`);
  process.exit(1);
}
const url = preview ? /https:\/\/[^\s]+\.workers\.dev/.exec(result.stdout)?.[0] : "https://terno.app";
if (url) {
  const res = await fetch(url).catch(() => null);
  console.log(res?.ok ? `\n✓ live: ${url}` : `\n! deployed, but ${url} didn't answer yet (a new custom domain can take a few minutes)`);
} else console.log("\n✓ deployed");
