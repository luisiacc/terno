#!/usr/bin/env node
// Plan 292, stage 4: how varied and how real the written mail is, over every batch (or the ones named).
//   node scripts/demo-corpus/report.mjs [batch-001 batch-002 …] [--json]
// Openers and sign-offs that repeat, 5-grams shared by many threads, near-duplicate messages, model tells, and the counts
// the AI features depend on (his sent mail in the last 30 days, the planted scenarios).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../packages/mock-data/demo-corpus");
const world = JSON.parse(readFileSync(join(root, "world.json"), "utf8"));
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const batches = named.length ? named : readdirSync(join(root, "threads")).filter((f) => /^batch-\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, "")).sort();
const threads = batches.flatMap((b) => JSON.parse(readFileSync(join(root, "threads", `${b}.json`), "utf8")).map((t) => ({ ...t, batch: b })));
const seeds = new Map(batches.flatMap((b) => { try { return JSON.parse(readFileSync(join(root, "seeds", `${b}.json`), "utf8")); } catch { return []; } }).map((s) => [s.id, s]));
const anchor = Date.parse(world.anchor);
const DAY = 86_400_000;

const people = new Map(world.people.map((p) => [p.id, p]));
for (const t of threads) for (const p of t.people ?? []) people.set(p.id, p);
const names = new Set([...people.values()].flatMap((p) => p.name.split(/\s+/)).concat(world.owner.name.split(" ")).map((n) => n.toLowerCase()));
// his signature follows the account: the Acme block on Acme Studio, the freelance block on Freelance (world.owner.style)
const signatureOf = (id, t) => (id === "me" ? (t.lang === "es" ? world.owner.style.es.signature : t.account === "acme" ? world.owner.style.en.signature : null) : people.get(id)?.style?.signature ?? null);
/** the text without its signature block, names replaced, for comparing voices */
const plain = (m, t) => {
  let text = m.text;
  const sig = signatureOf(m.from, t);
  if (sig && text.includes(sig)) text = text.slice(0, text.lastIndexOf(sig));
  return text;
};
const words = (s) => s.toLowerCase().match(/[\p{L}']+/gu) ?? [];
const norm = (ws) => ws.map((w) => (names.has(w) ? "NAME" : w));

const messages = threads.flatMap((t) => t.messages.map((m, i) => ({ t, m, i, body: plain(m, t) })));
const out = [];
const say = (s = "") => out.push(s);

// ---- counts ----
const byAccount = {};
for (const { t } of messages) byAccount[t.account] = (byAccount[t.account] ?? 0) + 1;
const mine = messages.filter((x) => x.m.from === "me");
const sent30 = mine.filter((x) => anchor - Date.parse(x.m.date) <= 30 * DAY).length;
say(`threads ${threads.length}, messages ${messages.length} (${Object.entries(byAccount).map(([a, n]) => `${a} ${n}`).join(", ")}), his ${mine.length}, his in the last 30 days ${sent30}`);
const plants = {};
for (const t of threads) { const p = seeds.get(t.id)?.plant; if (p) plants[p] = (plants[p] ?? 0) + 1; }
say(`planted: ${Object.entries(plants).map(([p, n]) => `${p} ${n}`).join(", ") || "none"}`);
const lengths = messages.map((x) => words(x.body).length).sort((a, b) => a - b);
const q = (f) => lengths[Math.floor(f * (lengths.length - 1))];
say(`words a message: p10 ${q(0.1)}, median ${q(0.5)}, p90 ${q(0.9)}, max ${q(1)}; one-liners (≤ 12 words) ${Math.round((100 * lengths.filter((n) => n <= 12).length) / lengths.length)} %`);

// ---- openers and sign-offs ----
const firstLine = (s) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const lastLine = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
const tally = (f) => {
  const m = new Map();
  for (const x of messages) {
    const k = norm(words(f(x.body))).slice(0, 4).join(" ");
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
};
const share = (n) => `${((100 * n) / messages.length).toFixed(1)} %`;
say("\nopeners (first four words of the first line, names as NAME):");
for (const [k, n] of tally(firstLine).slice(0, 12)) say(`  ${share(n).padStart(7)}  ${k}`);
say("sign-offs (last line before the signature):");
for (const [k, n] of tally(lastLine).slice(0, 12)) say(`  ${share(n).padStart(7)}  ${k}`);

// ---- 5-grams shared across threads ----
const grams = new Map();
for (const x of messages) {
  const ws = norm(words(x.body));
  const seen = new Set();
  for (let i = 0; i + 5 <= ws.length; i++) seen.add(ws.slice(i, i + 5).join(" "));
  for (const g of seen) {
    const s = grams.get(g) ?? new Set();
    s.add(x.t.id);
    grams.set(g, s);
  }
}
const shared = [...grams].map(([g, s]) => [g, s.size]).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
say(`\n5-grams in 5 or more threads: ${shared.length}`);
for (const [g, n] of shared.slice(0, 15)) say(`  ${String(n).padStart(4)}  ${g}`);

// ---- near-duplicates (shingle Jaccard ≥ 0.5 between messages of different threads) ----
const shingles = messages.map((x) => {
  const ws = norm(words(x.body));
  const s = new Set();
  for (let i = 0; i + 4 <= ws.length; i++) s.add(ws.slice(i, i + 4).join(" "));
  return s;
});
const index = new Map();
shingles.forEach((s, i) => { for (const g of s) { const l = index.get(g) ?? []; l.push(i); index.set(g, l); } });
const dupes = [];
shingles.forEach((s, i) => {
  if (s.size < 6) return;
  const overlap = new Map();
  for (const g of s) { const l = index.get(g); if (l.length > 40) continue; for (const j of l) if (j > i) overlap.set(j, (overlap.get(j) ?? 0) + 1); }
  for (const [j, n] of overlap) {
    if (messages[j].t.id === messages[i].t.id) continue;
    const jac = n / (s.size + shingles[j].size - n);
    if (jac >= 0.5) dupes.push([jac, i, j]);
  }
});
say(`\nnear-duplicate messages across threads: ${dupes.length}`);
for (const [jac, i, j] of dupes.sort((a, b) => b[0] - a[0]).slice(0, 8)) say(`  ${jac.toFixed(2)}  ${messages[i].t.id}#${messages[i].i + 1} ~ ${messages[j].t.id}#${messages[j].i + 1}`);

// ---- tells ----
const TELLS = ["i hope this email finds you well", "i hope you're well", "hope you're well", "hope you are well", "i wanted to reach out", "just wanted to", "circle back", "touch base", "let me know if you have any questions", "happy to help", "i'd be happy to", "looking forward to hearing", "thanks so much", "great question", "absolutely", "please don't hesitate", "quick question", "no worries", "sounds good", "espero que estés bien", "quedo atento", "quedo atenta", "quedo al pendiente", "saludos cordiales", "un abrazo"];
const tells = TELLS.map((p) => [p, messages.filter((x) => x.body.toLowerCase().includes(p)).length]).filter(([, n]) => n);
say(`\nstock phrases (share of messages): ${tells.map(([p, n]) => `"${p}" ${share(n)}`).join(", ")}`);
const dashes = messages.filter((x) => x.body.includes("—")).length;
say(`messages with an em dash: ${share(dashes)}; with a bullet list: ${share(messages.filter((x) => /^\s*[-*•] /m.test(x.body)).length)}; ending in a question: ${share(messages.filter((x) => /\?\s*$/.test(lastLine(x.body)) || /\?\s*\n/.test(x.body.trim().split("\n").slice(-2).join("\n"))).length)}`);
console.log(out.join("\n"));
