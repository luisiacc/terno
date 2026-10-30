import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("discovers physical disk storage tests only on Node and image storage coverage on both projects", () => {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const list = (project: string, file: string) => JSON.parse(execFileSync("pnpm", ["exec", "vitest", "list", "--project", project, file, "--filesOnly", "--json"], { cwd, encoding: "utf8" })) as { file: string; projectName: string }[];
  expect(list("unit", "packages/db/src/storage.test.ts")).toEqual([{ file: resolve(cwd, "packages/db/src/storage.test.ts"), projectName: "unit" }]);
  expect(list("db-wasm", "packages/db/src/storage.test.ts")).toEqual([]);
  for (const project of ["unit", "db-wasm"]) expect(list(project, "packages/db/src/storage-images.test.ts")).toEqual([{ file: resolve(cwd, "packages/db/src/storage-images.test.ts"), projectName: project }]);
});
