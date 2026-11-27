#!/usr/bin/env node
// Plan 292, stage 1: draws every thread's brief from the world and the taxonomy, deterministically, and packs them into
// batches for the writers (a storyline's threads stay in one batch, so one writer keeps them consistent).
//   node scripts/demo-corpus/seeds.mjs [--threads 900] [--batch 30]
// Writes packages/mock-data/demo-corpus/seeds/batch-NNN.json and seeds/batches.json (which writer each batch goes to).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../packages/mock-data/demo-corpus");
const world = JSON.parse(readFileSync(join(root, "world.json"), "utf8"));
const tax = JSON.parse(readFileSync(join(here, "taxonomy.json"), "utf8"));
tax.lists = JSON.parse(readFileSync(join(root, "lists.json"), "utf8"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TOTAL = arg("threads", 900);
const BATCH = arg("batch", 30);

// mulberry32, as the generator uses
let a = 290;
const rand = () => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const weighted = (entries) => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) if ((r -= w) <= 0) return v;
  return entries.at(-1)[0];
};
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const anchor = Date.parse(world.anchor);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const isoTime = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const accountLang = Object.fromEntries(world.accounts.map((x) => [x.key, x.lang]));
const accountWeights = world.accounts.map((x) => [x.key, x.weight]);

// A heavy tail: a few people write all the time, most now and then (as in a real address book).
const weightOf = new Map(world.people.map((p) => [p.id, Math.pow(rand(), -0.8)]));
const castOf = (account) => world.people.filter((p) => p.accounts.includes(account));
const pickPeople = (account, n) => {
  const pool = castOf(account).map((p) => [p.id, weightOf.get(p.id)]);
  const out = new Set();
  for (let guard = 0; out.size < Math.min(n, pool.length) && guard < 50; guard++) out.add(weighted(pool));
  return [...out];
};

const SHAPE_SPAN = { fyi: [0, 0], unanswered: [0, 0], "ask-answer": [0, 3], "back-and-forth": [1, 10], group: [1, 7], "luis-starts": [0, 5], forward: [0, 3], list: [1, 7] };
const peopleFor = { fyi: [1, 1], unanswered: [1, 1], "ask-answer": [1, 1], "back-and-forth": [1, 2], group: [3, 6], "luis-starts": [1, 2], forward: [1, 2], list: [2, 5] };
const length = () => weighted([["mixed", 50], ["short", 25], ["medium", 15], ["long", 10]]);
const attachments = () => weighted([["none", 80], ["some", 17], ["forgotten", 3]]);
const defaultTags = (account, people) => {
  if (account === "freelance") return ["client"];
  if (account === "acme") return people.some((id) => /client/i.test(world.people.find((p) => p.id === id)?.relationship ?? "")) ? ["client", "work"] : ["work"];
  return ["personal"];
};
/** when a thread ends: 35 % in the last 30 days, 25 % in the 90 before, 40 % back to two years */
const endAge = () => {
  const r = rand();
  return r < 0.35 ? rand() * 30 * DAY : r < 0.6 ? (30 + rand() * 90) * DAY : (120 + rand() * 605) * DAY;
};
const inboxFor = (age) => (age < 21 * DAY ? rand() < 0.75 : age < 120 * DAY ? rand() < 0.25 : rand() < 0.05);
const outcomeFor = (shape) => (shape === "fyi" ? "no reply needed" : shape === "unanswered" ? pick(["waiting on Luis", "dropped (nobody followed up)"]) : pick(tax.outcomes));
/** recent threads sometimes end in unread mail */
const unreadFor = (end) => (anchor - end < 3 * DAY && rand() < 0.5 ? isoTime(Math.max(end - int(1, 30) * HOUR, anchor - 3 * DAY)) : undefined);

function window(end, shape) {
  const [lo, hi] = SHAPE_SPAN[shape] ?? [0, 3];
  const span = int(lo, hi) * DAY;
  return [iso(Math.max(end - span, anchor - 730 * DAY)), iso(end)];
}

const units = []; // each unit: seeds that must share a batch
const base = (account, kind, people, shape, extra = {}) => {
  const end = extra.end ?? anchor - endAge();
  const age = anchor - end;
  const lastFrom = shape === "fyi" || shape === "unanswered" ? "them" : undefined;
  const firstFrom = shape === "luis-starts" ? "me" : undefined;
  const seed = {
    account,
    lang: accountLang[account],
    kind,
    people,
    shape,
    outcome: outcomeFor(shape),
    messages: tax.shapes[shape].messages,
    window: window(end, shape),
    length: length(),
    attachments: attachments(),
    tags: defaultTags(account, people),
    inbox: inboxFor(age),
    ...(firstFrom && { firstFrom }),
    ...(lastFrom && { lastFrom }),
    must: [],
  };
  const unread = unreadFor(end);
  if (unread && seed.lastFrom !== "me") seed.unreadFrom = unread;
  if (age > 200 * DAY && rand() < 0.04) Object.assign(seed, { trash: true, inbox: false });
  delete extra.end;
  return Object.assign(seed, extra);
};

// ---- planted scenarios (plan 292, revisions 5–9) ----
const plantAccounts = (n, spanish) => {
  const list = Array.from({ length: n }, () => weighted(accountWeights.filter(([k]) => k !== "freelance")));
  for (let i = 0; i < spanish; i++) list[i] = "freelance";
  return shuffle(list);
};
const p = tax.plants;
/** a planted thread's outcome is its scenario's, never a random one that contradicts it */
const PLANT_OUTCOME = { since: "the unread tail changes something (or, for one, nothing)", top: "waiting on Luis", "owner-promise": "Luis owes what he promised", "promise-to-owner": "they owe what they promised", awaiting: "no answer yet", deadline: "waiting on Luis, before the date", "waiting-on-you": "waiting on Luis" };
const plant = (name, account, shape, extra) =>
  units.push([base(account, `planted: ${name}`, pickPeople(account, extra.n ?? 1), shape, { plant: name, must: [p[name].about, ...(extra.must ?? [])], ...(PLANT_OUTCOME[name] && { outcome: PLANT_OUTCOME[name] }), ...extra.seed })]);
const days = (n) => anchor - n * DAY;

["acme", "personal", "freelance", "acme"].forEach((account, i) =>
  plant("since", account, "back-and-forth", {
    n: i === 0 ? 2 : 1,
    must: [i === 3 ? "This is the one where the new mail changes nothing: a short thanks or acknowledgement." : "The unread tail changes something specific the read mail had settled."],
    seed: { messages: [3, 6], window: [iso(days(8)), iso(anchor)], end: anchor, unreadFrom: isoTime(anchor - 2 * HOUR), lastFrom: "them", inbox: true },
  }),
);
["acme", "acme", "personal", "icloud", "freelance", "freelance"].forEach((account, i) =>
  plant("top", account, i % 2 ? "ask-answer" : "unanswered", {
    must: [i === 0 ? `The last message is dated exactly ${isoTime(anchor)} (that is ${new Date(anchor).toISOString().slice(11, 16)} UTC; write it in the sender's own offset).` : "The last message is dated today, the anchor day, before 15:30 UTC."],
    seed: { messages: i % 2 ? [2, 3] : [1, 1], window: [iso(days(i % 2 ? 3 : 0)), iso(anchor)], end: anchor, unreadFrom: isoTime(anchor - 8 * HOUR), lastFrom: "them", inbox: true },
  }),
);
plantAccounts(12, 3).forEach((account) =>
  plant("owner-promise", account, weighted([["back-and-forth", 2], ["ask-answer", 1], ["luis-starts", 1]]), {
    seed: { window: [iso(days(14)), iso(anchor)], end: anchor - rand() * 13 * DAY, lastFrom: "me" },
  }),
);
plantAccounts(10, 2).forEach((account) =>
  plant("promise-to-owner", account, weighted([["back-and-forth", 2], ["ask-answer", 2]]), {
    seed: { window: [iso(days(14)), iso(days(1))], end: days(1 + rand() * 12), lastFrom: "them", inbox: true },
  }),
);
plantAccounts(10, 2).forEach((account) =>
  plant("awaiting", account, "luis-starts", {
    seed: { messages: [1, 3], window: [iso(days(13)), iso(days(6))], end: days(6 + rand() * 7), lastFrom: "me", inbox: false },
  }),
);
plantAccounts(10, 2).forEach((account) =>
  plant("deadline", account, weighted([["unanswered", 1], ["back-and-forth", 1]]), {
    must: [`The date he must act by falls between ${iso(anchor + DAY)} and ${iso(anchor + 10 * DAY)}.`],
    seed: { window: [iso(days(14)), iso(anchor)], end: anchor - rand() * 13 * DAY, lastFrom: "them", inbox: true },
  }),
);
plantAccounts(6, 1).forEach((account, i) =>
  plant("waiting-on-you", account, "back-and-forth", {
    must: i === 0 ? ["This person has nothing else open with Luis anywhere in the mailbox: their only item is this question."] : [],
    seed: { messages: [3, 6], window: [iso(days(10)), iso(anchor)], end: anchor - rand() * 8 * DAY, firstFrom: "me", lastFrom: "them", inbox: true },
  }),
);
plantAccounts(6, 1).forEach((account) => plant("facts", account, weighted([["back-and-forth", 2], ["group", 1]]), { n: 2, seed: {} }));

const planted = units.flat().length;

// ---- storylines ----
for (const s of world.storylines) {
  const from = Date.parse(s.from);
  const to = Math.min(Date.parse(s.to) + DAY - 1, anchor);
  const k = Math.max(2, Math.min(6, Math.round((to - from) / (20 * DAY)) + 1));
  const unit = [];
  for (let i = 0; i < k; i++) {
    const end = from + ((i + 1) / k) * (to - from);
    const shape = weighted([["ask-answer", 3], ["back-and-forth", 4], ["group", 2], ["luis-starts", 2], ["fyi", 1], ["forward", 1]]);
    const people = shuffle([...s.people]).slice(0, int(...(peopleFor[shape] ?? [1, 2])));
    const seed = base(s.account, `storyline: ${s.title}`, people.length ? people : s.people.slice(0, 1), shape, { storyline: s.id, end });
    seed.window = [iso(Math.max(from, end - (SHAPE_SPAN[shape]?.[1] ?? 3) * DAY)), iso(end)];
    seed.must.push(`Part ${i + 1} of ${k} of the storyline "${s.title}": write what happens in this stretch (${seed.window[0]} to ${seed.window[1]}), consistent with its summary.`);
    unit.push(seed);
  }
  units.push(unit);
}

// ---- lists, strangers, the rest ----
const listCount = Math.round(TOTAL * 0.07);
const strangerCount = Math.round(TOTAL * 0.08);
for (let i = 0; i < listCount; i++) {
  const list = pick(tax.lists);
  const shape = "list";
  units.push([base(list.account, `a discussion on ${list.name} (${list.about})`, pickPeople(list.account, int(1, 3)), shape, { list: list.id, must: [`On the list ${list.address} (listId ${list.listId}): messages go to the list, not to Luis by name; Luis may or may not take part.`] })]);
}
for (let i = 0; i < strangerCount; i++) {
  const account = weighted(accountWeights);
  const shape = weighted([["unanswered", 3], ["fyi", 1], ["ask-answer", 2]]);
  units.push([base(account, pick(tax.strangers[account]), [], shape, { must: ["The sender is a one-off person: define them in the thread's people."] })]);
}
// Freelance's storylines already carry most of its mail: the free threads lean English, so Spanish stays about a sixth
const freeWeights = [["personal", 0.42], ["acme", 0.4], ["freelance", 0.06], ["icloud", 0.12]];
const rest = TOTAL - units.flat().length;
for (let i = 0; i < rest; i++) {
  const account = weighted(freeWeights);
  const shape = weighted(Object.entries(tax.shapeWeights).filter(([s]) => s !== "list"));
  const people = pickPeople(account, int(...peopleFor[shape]));
  units.push([base(account, `free: ${pick(tax.nudges[account])}`, people, shape)]);
}

// ---- batches ----
shuffle(units);
const batches = [];
let current = [];
for (const unit of units) {
  if (current.length && current.length + unit.length > BATCH) {
    batches.push(current);
    current = [];
  }
  current.push(...unit);
}
if (current.length) batches.push(current);

mkdirSync(join(root, "seeds"), { recursive: true });
let n = 0;
const manifest = batches.map((seeds, i) => {
  const name = `batch-${String(i + 1).padStart(3, "0")}`;
  seeds.sort((x, y) => x.window[1].localeCompare(y.window[1]));
  for (const s of seeds) s.id = `s${String(++n).padStart(4, "0")}`;
  const ordered = seeds.map(({ id, ...rest }) => ({ id, ...rest }));
  writeFileSync(join(root, "seeds", `${name}.json`), `${JSON.stringify(ordered, null, 1)}\n`);
  return { batch: name, writer: i % 2 ? "codex" : "claude", seeds: seeds.length, planted: seeds.filter((s) => s.plant).length, spanish: seeds.filter((s) => s.lang === "es").length };
});
writeFileSync(join(root, "seeds", "batches.json"), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`${n} seeds (${planted} planted, ${listCount} list, ${strangerCount} strangers) in ${batches.length} batches`);
