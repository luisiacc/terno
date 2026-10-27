/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction, constants } from "node:vm";
import type { parseRaw } from "../mime";

/** Measure shipped ESM execution, including the first lazy helper load, without Vitest transforming dependency sources. */
export async function bundledParser(): Promise<{ parseRaw: typeof parseRaw; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "terno-visible-parser-"));
  const root = resolve(import.meta.dirname, "../../../..");
  try {
    execFileSync(join(root, "apps/desktop/node_modules/.bin/esbuild"), [join(root, "packages/mail/src/mime.ts"), "--bundle", "--format=esm", "--splitting", "--platform=browser", "--target=chrome140", "--minify", `--outdir=${dir}`, "--out-extension:.js=.mjs", "--log-level=error"]);
    const load = compileFunction("return import(specifier)", ["specifier"], { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as (specifier: string) => Promise<{ parseRaw: typeof parseRaw }>;
    const parser = await load(pathToFileURL(join(dir, "mime.mjs")).href);
    return { parseRaw: parser.parseRaw, close: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}
