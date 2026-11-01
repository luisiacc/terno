// plan 97: what `pnpm deploy:site` runs, in order (Codex review 1: the database exists and is migrated before a
// Worker that needs it goes live; any failing step stops everything after it). Pure, so a test checks the order.

/** @param {{ preview: boolean }} o */
export function deploySteps({ preview }) {
  const env = preview ? ["--env", "preview"] : ["--env", ""];
  const database = preview ? "terno-site-waitlist-preview" : "terno-site-waitlist";
  return [
    { name: "signed in", cmd: "pnpm", args: ["exec", "wrangler", "whoami"], hint: "run `pnpm --filter @terno/site exec wrangler login`" },
    { name: "tests", cmd: "pnpm", args: ["exec", "vitest", "run", "--project", "unit", "apps/site"], cwd: "repo", hint: "the site's tests failed" },
    { name: "build", cmd: "pnpm", args: ["build"], hint: "the build failed" },
    { name: "database", ensureDatabase: database, hint: `couldn't find or create the D1 database ${database}` },
    { name: "migrations", cmd: "pnpm", args: ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote", ...env], hint: "the waitlist migration didn't apply" },
    { name: "deploy", cmd: "pnpm", args: ["exec", "wrangler", "deploy", ...env], capture: true, hint: "wrangler deploy failed (the live site is unchanged)" },
  ];
}

/**
 * Runs the steps in order and stops at the first failure. `exec(step)` runs one command and returns
 * `{ ok, stdout }`; `ensureDatabase(name)` returns whether the database exists or was created.
 * @returns {Promise<{ ok: boolean; failed?: string; hint?: string; stdout: string }>}
 */
export async function runSteps(steps, { exec, ensureDatabase }) {
  let stdout = "";
  for (const step of steps) {
    const ok = step.ensureDatabase ? await ensureDatabase(step.ensureDatabase) : await exec(step).then((r) => ((stdout = r.stdout ?? stdout), r.ok));
    if (!ok) return { ok: false, failed: step.name, hint: step.hint, stdout };
  }
  return { ok: true, stdout };
}
