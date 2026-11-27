#!/usr/bin/env node
// Plan 292: a tended mailbox. The seeds kept 75 % of recent threads in the Inbox whatever their outcome, so settled
// conversations (resolved, decided, declined …) sat there waiting and What matters counted 134. A person files most of
// what's settled: this archives about four in five of them, deterministically, in the seed and the thread together.
// Planted threads, threads with unread mail and threads still open stay as they are.
//   node scripts/demo-corpus/tend.mjs [--dry]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../packages/mock-data/demo-corpus");
const dry = process.argv.includes("--dry");
const SETTLED = new Set(["resolved", "decided", "rescheduled", "cancelled", "a misunderstanding cleared up", "declined politely", "no reply needed"]);
const share = (id) => {
  let h = 0x811c9dc5;
  for (const c of `tend:${id}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
let before = 0;
let archived = 0;
for (const file of readdirSync(join(root, "seeds")).filter((f) => /^batch-\d+\.json$/.test(f)).sort()) {
  const seedPath = join(root, "seeds", file);
  const threadPath = join(root, "threads", file);
  const seeds = JSON.parse(readFileSync(seedPath, "utf8"));
  const threads = JSON.parse(readFileSync(threadPath, "utf8"));
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const s of seeds) {
    const t = byId.get(s.id);
    if (!t?.state.inbox) continue;
    before++;
    if (s.plant || !SETTLED.has(s.outcome) || t.messages.some((m) => m.from !== "me" && !m.read) || share(s.id) >= 0.8) continue;
    s.inbox = false;
    t.state.inbox = false;
    archived++;
  }
  if (!dry) {
    const indent = (text) => /^\[\n( +)[{"]/.exec(text)?.[1].length ?? 1;
    writeFileSync(seedPath, `${JSON.stringify(seeds, null, indent(readFileSync(seedPath, "utf8")))}\n`);
    writeFileSync(threadPath, `${JSON.stringify(threads, null, indent(readFileSync(threadPath, "utf8")))}\n`);
  }
}
console.log(`${archived} of ${before} written threads in the Inbox archived${dry ? " (dry run)" : ""}`);
