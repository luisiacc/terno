// Electron >= 44 no longer downloads its binary in a postinstall script.
// Run its installer explicitly so `electron` is usable in dev and by Playwright.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(join(process.cwd(), "apps/desktop/package.json"));
let electronDir;
try {
  electronDir = dirname(require.resolve("electron/package.json"));
} catch {
  process.exit(0); // desktop deps not installed (e.g. filtered install)
}
const pathFile = join(electronDir, "path.txt");
if (existsSync(pathFile)) process.exit(0);
const result = spawnSync(process.execPath, [join(electronDir, "install.js")], { stdio: "inherit" });
process.exit(result.status ?? 1);
