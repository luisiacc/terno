// Writes src/styles/themes.generated.css from the registry (checked in; a test fails on drift).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateThemesCss } from "../src/themes/generate";

const out = join(import.meta.dirname, "../src/styles/themes.generated.css");
writeFileSync(out, generateThemesCss());
console.log(`wrote ${out}`);
