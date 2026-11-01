// `pnpm deploy:site` (production: terno.app) and `pnpm deploy:site:preview` (terno-site-preview on workers.dev,
// its own database, noindex). Plan 96. Builds, checks, deploys, applies the waitlist migrations, then checks the
// live site answers. The D1 database is created by the first deploy (wrangler provisions bindings without an id).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(site, "..", "..");
const preview = process.argv.includes("--preview");
// the top-level (production) environment, named explicitly because the config also has `env.preview`
const env = preview ? ["--env", "preview"] : ["--env", ""];
const fail = (m) => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};
const run = (cmd, args, cwd = site, capture = false) => {
  console.log(`\n› ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (capture && r.stdout) process.stdout.write(r.stdout);
  return r;
};

if (run("pnpm", ["exec", "wrangler", "whoami"], site, true).status !== 0) fail("wrangler isn't signed in: run `pnpm --filter @terno/site exec wrangler login`");
if (run("pnpm", ["exec", "vitest", "run", "--project", "unit", "apps/site"], repo).status !== 0) fail("the site's tests failed: nothing was deployed");
if (run("pnpm", ["build"]).status !== 0) fail("the build failed: nothing was deployed");
const deployed = run("pnpm", ["exec", "wrangler", "deploy", ...env], site, true);
if (deployed.status !== 0) fail("wrangler deploy failed (the live site is unchanged)");
if (run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote", ...env]).status !== 0) fail("deployed, but the waitlist migration didn't apply: run it again with `pnpm --filter @terno/site exec wrangler d1 migrations apply DB --remote" + (preview ? " --env preview`" : "`"));

const url = preview ? /https:\/\/[^\s]+\.workers\.dev/.exec(deployed.stdout ?? "")?.[0] : "https://terno.app";
if (url) {
  const res = await fetch(url).catch(() => null);
  console.log(res?.ok ? `\n✓ live: ${url}` : `\n! deployed, but ${url} didn't answer yet (a new custom domain can take a few minutes)`);
} else console.log("\n✓ deployed");
