import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, loadConfigFromFile } from "vite";

const web = resolve(import.meta.dirname, "..");

async function fixture(run) {
  const temp = mkdtempSync(join(tmpdir(), "terno-web-maps-"));
  const name = `dist-web-maps-${temp.split("/").at(-1)}`;
  const out = join(web, name);
  const archive = join(web, ".maps", name);
  const argv = process.argv;
  const target = process.env.VITE_TARGET;
  try {
    process.argv = [...argv, "--outDir", name];
    process.env.VITE_TARGET = "web";
    const loaded = await loadConfigFromFile({ command: "build", mode: "test" }, join(web, "vite.config.ts"));
    assert.ok(loaded);
    const entry = join(temp, "entry.js");
    const compile = () => build({
      ...loaded.config,
      configFile: false,
      root: web,
      mode: "test",
      logLevel: "silent",
      build: { ...loaded.config.build, outDir: out, rollupOptions: { input: entry } },
    });
    await run({ compile, entry, out, archive });
  } finally {
    process.argv = argv;
    if (target === undefined) delete process.env.VITE_TARGET;
    else process.env.VITE_TARGET = target;
    rmSync(temp, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
}

for (const stale of [false, true]) test(`failed Web build preserves resolution error and archive (stale output: ${stale})`, async () => {
  await fixture(async ({ compile, entry, out, archive }) => {
    writeFileSync(entry, 'import "./missing-synthetic-module.js";');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "previous"), "previous build maps");
    if (stale) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "previous.js"), "previous output");
    }
    const latest = join(web, ".maps", "LATEST");
    const pointer = existsSync(latest) ? readFileSync(latest, "utf8") : undefined;
    await assert.rejects(compile, /Could not resolve.*missing-synthetic-module/);
    assert.equal(existsSync(latest) ? readFileSync(latest, "utf8") : undefined, pointer);
    assert.equal(readFileSync(join(archive, "previous"), "utf8"), "previous build maps");
  });
});

test("successful Web build tags code and archives maps outside output", async () => {
  await fixture(async ({ compile, entry, out, archive }) => {
    writeFileSync(entry, 'console.log("synthetic build");');
    await compile();
    const assets = readdirSync(join(out, "assets"));
    const code = assets.find((name) => name.endsWith(".js"));
    assert.ok(code);
    assert.ok(!assets.some((name) => name.endsWith(".map")));
    assert.match(readFileSync(join(out, "assets", code), "utf8"), /\/\/# debugId=/);
    const map = JSON.parse(readFileSync(join(archive, "assets", `${code}.map`), "utf8"));
    assert.ok(map.debugId);
    assert.ok(existsSync(join(archive, "assets", code)));
  });
});
