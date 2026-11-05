/**
 * Project unit, backend tests only: a new database starts as a copy of one migrated file, and a Backend starts no
 * checkpoint thread. Migrating a file and spawning that thread cost every one of 2,000 tests 40 to 100 ms for what none
 * of them asks: packages/db proves both (migrations.test.ts, repos.test.ts), a database that already exists still
 * migrates here, and the perf project runs without this file.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect } from "vitest";

if (expect.getState().testPath?.includes("/packages/backend/src/")) {
  const { nodeSqliteDriver, openDatabaseWith, useSqliteDriver } = await import("@terno/db");
  let template: string | undefined;
  const migrated = () => {
    if (template) return template;
    const path = join(mkdtempSync(join(tmpdir(), "terno-template-")), "template.db");
    // closing the last connection checkpoints and drops the WAL: this one file is the whole database
    openDatabaseWith(nodeSqliteDriver, path).close();
    return (template = path);
  };
  afterAll(() => { if (template) rmSync(dirname(template), { recursive: true, force: true }); });
  useSqliteDriver({
    ...nodeSqliteDriver,
    features: { ...nodeSqliteDriver.features, checkpointWorker: false },
    open(path, options) {
      if (!options.readonly && path !== ":memory:" && !existsSync(path)) copyFileSync(migrated(), path);
      return nodeSqliteDriver.open(path, options);
    },
  });
}
