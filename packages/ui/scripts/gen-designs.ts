// Writes src/styles/designs.generated.css from the design definitions (checked in; a test fails on drift).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDesignsCss, generateTypeRolesCss } from "../src/designs/generate";

const out = join(import.meta.dirname, "../src/styles/designs.generated.css");
writeFileSync(out, generateDesignsCss());
console.log(`wrote ${out}`);
const roles = join(import.meta.dirname, "../src/styles/type-roles.generated.css");
writeFileSync(roles, generateTypeRolesCss());
console.log(`wrote ${roles}`);
