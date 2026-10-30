/// <reference types="node" />
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function selectionWriteViolations(root: string): string[] {
  const violations: string[] = [];
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(file) || /(?:\.test\.|\.spec\.|harness\.)/.test(file) || /(?:^|[\\/])test[\\/]/.test(file) || file === "state/app.ts") continue;
    const source = readFileSync(join(root, file), "utf8");
    const aliases = new Set<string>();
    for (const match of source.matchAll(/\buseApp(?:\s+as\s+(\w+))?\b/g)) aliases.add(match[1] ?? "useApp");
    for (const match of source.matchAll(/\buseApp\s*:\s*(\w+)/g)) aliases.add(match[1]!);
    let changed = true;
    while (changed) {
      changed = false;
      for (const match of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\b/g)) {
        if (aliases.has(match[2]!) && !aliases.has(match[1]!)) { aliases.add(match[1]!); changed = true; }
      }
    }
    for (const alias of aliases) {
      if (new RegExp(`\\b${alias}\\s*(?:\\.\\s*setState\\b|\\[\\s*["']setState["']\\s*\\])`).test(source) || new RegExp(`\\{[^}]*\\bsetState\\b[^}]*\\}\\s*=\\s*${alias}\\b`).test(source)) violations.push(file);
    }
  }
  return violations;
}

it("keeps production app-store writes on the selection-aware setter", () => {
  const root = join(import.meta.dirname, "..");
  const violations = selectionWriteViolations(root);
  const app = readFileSync(join(root, "state/app.ts"), "utf8");
  const start = app.indexOf("export function setApp("), end = app.indexOf("export const getApp =");
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  expect(`${app.slice(0, start)}${app.slice(end)}`).not.toMatch(/\buseApp\s*(?:\.\s*setState\b|\[\s*["']setState["']\s*\])/);
  expect(violations).toEqual([]);
});

it("excludes test helpers but catches production writes through aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "terno-selection-scan-"));
  try {
    mkdirSync(join(root, "lib/test"), { recursive: true });
    const source = 'import { useApp as app } from "~/state/app"; const store = app; store.setState({ selected: [] });';
    writeFileSync(join(root, "lib/test/helper.tsx"), source);
    writeFileSync(join(root, "lib/production.tsx"), source);
    expect(selectionWriteViolations(root)).toEqual(["lib/production.tsx"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
