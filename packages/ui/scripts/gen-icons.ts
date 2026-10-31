// Writes src/iconset/generated/*.ts and src/icons.ts (`@terno/ui/icons`) from src/iconset/catalog.ts (checked in; a test fails on drift).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ICONS } from "../src/iconset/catalog";
import { generateIcon, generateIndex } from "../src/iconset/generate";

const dir = join(import.meta.dirname, "../src/iconset");
const out = join(dir, "generated");
mkdirSync(out, { recursive: true });
const names = Object.keys(ICONS) as (keyof typeof ICONS)[];
// an icon dropped from the catalog loses its module
for (const f of readdirSync(out)) if (!names.includes(f.replace(/\.ts$/, "") as keyof typeof ICONS)) rmSync(join(out, f));
for (const name of names) writeFileSync(join(out, `${name}.ts`), generateIcon(name));
writeFileSync(join(import.meta.dirname, "../src/icons.ts"), generateIndex());
console.log(`wrote ${names.length} icons to ${out}`);
