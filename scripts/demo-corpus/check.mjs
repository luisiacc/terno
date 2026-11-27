#!/usr/bin/env node
// Plan 292: checks the written demo mailbox's sources. Writers run it on their batch until it prints "ok".
//   node scripts/demo-corpus/check.mjs world                 the world alone
//   node scripts/demo-corpus/check.mjs batch-001             threads/batch-001.json against seeds/batch-001.json
//   node scripts/demo-corpus/check.mjs all                   every batch
//   node scripts/demo-corpus/check.mjs bulk                  the machine mail's templates and the spam
// Exit 1 on any error; warnings are printed and don't fail.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBulk, validateThreads, validateWorld } from "../../packages/mock-data/src/demo-corpus/rules.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../packages/mock-data/demo-corpus");
const world = JSON.parse(readFileSync(join(root, "world.json"), "utf8"));
const lists = JSON.parse(readFileSync(join(root, "lists.json"), "utf8"));

function readThreads(file) {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [{ id: file, parseError: "not an array of threads" }];
  } catch (e) {
    return [{ id: file, parseError: e.message }];
  }
}

const arg = process.argv[2];
if (!arg) { console.error("usage: check.mjs world | batch-NNN | all"); process.exit(2); }
let issues = validateWorld(world);
if (arg === "bulk") {
  const dir = join(root, "bulk");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "spam.json") : [];
  const bulk = [];
  for (const f of files) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8"));
      bulk.push(...(Array.isArray(v) ? v : [v]));
    } catch (e) { issues.push({ level: "error", where: `bulk/${f}`, message: `not JSON: ${e.message}` }); }
  }
  const spamFile = join(dir, "spam.json");
  const spam = existsSync(spamFile) ? JSON.parse(readFileSync(spamFile, "utf8")) : [];
  issues = issues.concat(validateBulk(world, bulk, spam));
} else if (arg !== "world") {
  const batches = arg === "all" ? readdirSync(join(root, "threads")).filter((f) => /^batch-\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, "")).sort() : [arg.replace(/^.*\//, "").replace(/\.json$/, "")];
  const ids = new Map();
  for (const b of batches) {
    const file = join(root, "threads", `${b}.json`);
    if (!existsSync(file)) { console.error(`no ${file}`); process.exit(2); }
    const threads = readThreads(file);
    for (const t of threads.filter((t) => t.parseError)) issues.push({ level: "error", where: t.id, message: `not JSON: ${t.parseError}` });
    const parsed = threads.filter((t) => !t.parseError);
    for (const t of parsed) {
      if (ids.has(t.id)) issues.push({ level: "error", where: t.id, message: `also in ${ids.get(t.id)}` });
      ids.set(t.id, b);
    }
    const seedFile = join(root, "seeds", `${b}.json`);
    const seeds = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, "utf8")) : [];
    issues = issues.concat(validateThreads(world, parsed, seeds, lists).map((i) => ({ ...i, where: `${b}: ${i.where}` })));
  }
}
const errors = issues.filter((i) => i.level === "error");
for (const i of issues) console.log(`${i.level === "error" ? "ERROR" : "warn "} ${i.where}: ${i.message}`);
console.log(errors.length ? `${errors.length} errors, ${issues.length - errors.length} warnings` : `ok (${issues.length} warnings)`);
process.exit(errors.length ? 1 : 0);
