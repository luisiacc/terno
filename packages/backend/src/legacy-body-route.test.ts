/**
 * Plan 253: which mailboxes the exclusive legacy-body owner opens. Only the
 * ones its one-time conversion is for; any other migration runs in the
 * host's own open, whose checkpoints wait for the backup's first write.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BODY_PARTS_SCHEMA, BODY_READY_APPLICATION_ID, BODY_UPGRADE_APPLICATION_ID, SCHEMA_VERSION } from "@terno/db";
import { needsLegacyBodyUpgrade } from "./legacy-body-worker";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** a file with only SQLite's header: user_version at 60, application_id at 68 */
function headerOnly(version: number, applicationId: number): string {
  const dir = mkdtempSync(join(tmpdir(), "terno-route-"));
  dirs.push(dir);
  const b = Buffer.alloc(100);
  b.write("SQLite format 3\0", 0, "ascii");
  b.writeUInt32BE(version, 60);
  b.writeUInt32BE(applicationId, 68);
  writeFileSync(join(dir, "terno.db"), b);
  return join(dir, "terno.db");
}

it.each([
  ["an older mailbox already converted goes to the host's own open", SCHEMA_VERSION - 1, BODY_READY_APPLICATION_ID, false],
  ["a current one too", SCHEMA_VERSION, BODY_READY_APPLICATION_ID, false],
  ["one that crosses the body-parts step goes to the owner", BODY_PARTS_SCHEMA - 1, BODY_READY_APPLICATION_ID, true],
  ["one past it but never marked converted goes to the owner", SCHEMA_VERSION - 1, 0, true],
  ["a conversion left pending goes to the owner, even at the current schema", SCHEMA_VERSION, BODY_UPGRADE_APPLICATION_ID, true],
] as const)("%s", async (_name, version, applicationId, owner) => {
  expect(await needsLegacyBodyUpgrade(headerOnly(version, applicationId))).toBe(owner);
});
