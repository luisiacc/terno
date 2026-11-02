import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * The backend, providers, MCP and hosts reach storage only through MailStore
 * commands (so every write can feed the search outbox, and another adapter can
 * replace SQLite). The only SQL-aware code is the backend's default store and
 * its opening: the exclusive legacy-body upgrade runs on its own worker before
 * the store is admitted (w11 MIME byte retention).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    // test support (fixtures, measurement scripts) ships nowhere
    return /\.tsx?$/.test(e.name) && !/\.(test|perf\.test|spec)\.ts$|[.-]fixture\.ts$|\.measure\.ts$/.test(e.name) ? [p] : [];
  });
}

/** file → what it may import from @terno/db: opening and upgrading the mailbox, never querying it */
const OPENING: Record<string, string[]> = {
  "packages/backend/src/backend.ts": ["nodePlatform", "openDatabase", "SqlMailStore", "SEARCH_SCHEMA_VERSION", "openingSqlStore", "type Db", "type OpenOptions"],
  "packages/backend/src/legacy-body-worker.ts": ["BODY_UPGRADE_APPLICATION_ID", "SCHEMA_VERSION", "MigrationError", "SchemaNewerError", "type OpenFailure", "BodyUpgradeProgress"],
  "packages/backend/src/incoming.worker.ts": ["nodeSqliteDriver", "nodePlatform", "openDatabaseWith", "upgradeLegacyBodies", "classifyOpenError", "type BodyUpgradeProgress"],
};

const DB_ACCESS = /\b(?:db|db\(\))\.(?:all|get|run|tx|exec|prepare)\s*[<(]|\.db\b(?!\w)/;

it("backend, providers and MCP never touch the database directly", () => {
  const files = ["packages/backend/src", "packages/mail/src", "packages/mcp/src"].flatMap((d) => sources(join(ROOT, d)));
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@terno\/db"/g)) {
      const names = m[2]!.split(",").map((n) => n.trim()).filter(Boolean);
      const allowed = names.every((n) => OPENING[rel]?.includes(n));
      if (!allowed) offenders.push(`${rel}: imports ${names.join(", ")} from @terno/db`);
    }
    code.split("\n").forEach((line, i) => {
      if (DB_ACCESS.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

it("hosts write settings through the store, not SQL", () => {
  for (const rel of ["apps/desktop/src/backend-entry.ts", "apps/backend-dev/src/server.ts"]) {
    const code = readFileSync(join(ROOT, rel), "utf8");
    expect(code, rel).not.toMatch(/backend\.db\b|\bdb\.(run|get|all|exec)\(|INSERT |SELECT |UPDATE /);
  }
});
