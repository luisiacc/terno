import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * The backend, providers, MCP and hosts reach storage only through MailStore
 * commands (so every write can feed the search outbox, and another adapter can
 * replace SQLite). The only SQL-aware line is the backend's default store.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|perf\.test|spec)\.ts$/.test(e.name) ? [p] : [];
  });
}

const DB_ACCESS = /\b(?:db|db\(\))\.(?:all|get|run|tx|exec|prepare)\s*[<(]|\.db\b(?!\w)/;

it("backend, providers and MCP never touch the database directly", () => {
  const files = ["packages/backend/src", "packages/mail/src", "packages/mcp/src"].flatMap((d) => sources(join(ROOT, d)));
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@unica\/db"/g)) {
      const names = m[2]!.split(",").map((n) => n.trim()).filter(Boolean);
      const allowed = rel === "packages/backend/src/backend.ts" && names.every((n) => ["nodePlatform", "openDatabase", "SqlMailStore"].includes(n));
      if (!allowed) offenders.push(`${rel}: imports ${names.join(", ")} from @unica/db`);
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
