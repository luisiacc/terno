import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Backend, plaintextCipher, type SecretCipher } from "../../packages/backend/src/backend";
import { createMemoryTransportPair, RpcClient } from "../../packages/core/src/rpc";
import { demoRegistry } from "../../packages/mail/src";
import type { IncomingMessage } from "../../packages/store/src";
import type { TodayAlso, TodayItem, TodaySection } from "../../packages/core/src/today";
import type { DatedRow } from "../../packages/core/src/dated";
import type { FollowupRow } from "../../packages/core/src/followups";
import { msg } from "../../packages/store/src/conformance/fixtures";
import { realAiFactory } from "../../apps/backend-dev/src/real-ai";
import { createAi, DATED_PROMPT_VERSION, FOLLOWUP_PROMPT_VERSION, SUMMARY_PROMPT_VERSION, type ModelTransport } from "../../packages/ai/src";
import { realKeys, spendReport } from "./harness";

/**
 * Plan 204's user panel: each persona's mailbox (fictional, outside the repo under TERNO_PANEL_DIR/mail) with the
 * background mail written for that persona (`<id>.filler.json`, plan 210: the owner's "noise written for each persona",
 * instead of corpus mail that put other people's words in their Sent), read by the real dated reader and follow-ups on
 * real models, under the spend ledger. In two phases, so Missed is real: the 14-day check on Tuesday 2026-11-10 09:00,
 * then the rest as live mail on Friday 2026-11-13 09:00. What Today shows is written beside the database. The API keys
 * live only in this process (`heldKeys`): the database holds handles that open nothing, whatever way the run ends, and
 * the copy is left on the demo's provider, so the app opens it with no key. Nothing reaches a mail server (the demo
 * registry, no sync). Run alone: TERNO_AI_REAL=1 TERNO_PANEL=1, in the persona's zone (TZ).
 *
 * The second morning (plan 210, TERNO_PANEL_DAY2=1): the same mailbox on Saturday 2026-11-14 09:30, after Friday as the
 * persona lived it (`<id>.day1.json`: what they did on the feed and the mail they sent; `<id>.day2.json`: the mail that came
 * in overnight), on a copy of Friday's database, so reviewers can judge whether the feed keeps its word.
 */
const DIR = process.env.TERNO_PANEL_DIR ?? "/tmp/terno-scratch/p204/panel";
/** where each persona's database goes (a proof run keeps its own, beside the round's) */
const DB = process.env.TERNO_PANEL_DB ?? join(DIR, "db");
/** the second morning's: a copy of `DB`'s, played on to Saturday */
const DB2 = process.env.TERNO_PANEL_DB2 ?? join(DIR, "db-day2");
const DAY2 = process.env.TERNO_PANEL_DAY2 === "1";
const ONLY = process.env.TERNO_PANEL_ONLY?.split(",");
const PHASE_ONE = new Date(2026, 10, 10, 9, 0).getTime();
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
const SATURDAY = new Date(2026, 10, 14, 9, 30).getTime();
const DAY = 86_400_000;

interface Person { name: string; email: string }
interface Mail { id: string; thread: string; from: Person; to: Person[]; cc?: Person[]; subject: string; date: string; text: string; sent?: boolean; list?: string | null; bulk?: boolean; gmail?: string }
interface Box { id: string; me: Person; language: "en" | "es"; messages: Mail[] }

const mailFile = (id: string, suffix: string): string => join(DIR, "mail", `${id}${suffix}.json`);

/** The persona's background mail, written in their world (plan 210): required, so a mailbox is never read without it. */
const fillerOf = (id: string): Mail[] => JSON.parse(readFileSync(mailFile(id, ".filler"), "utf8")) as Mail[];

/**
 * The harness's secret store (plan 210, Codex review of iteration 1): a key is held in this process alone and the
 * database keeps a handle (`held:1`) that opens nothing anywhere else, so no database under the panel's folder ever
 * holds a key, even when a run fails before it could clear them.
 */
function heldKeys(): SecretCipher {
  const held = new Map<string, string>();
  return {
    async encrypt(plain) {
      const handle = `held:${held.size + 1}`;
      held.set(handle, plain);
      return new TextEncoder().encode(handle);
    },
    async decrypt(blob) {
      const value = held.get(new TextDecoder().decode(blob));
      if (value === undefined) throw new Error("a key from another run");
      return value;
    },
  };
}

const atOf = (m: Mail): number => (m.date.endsWith("Z") ? Date.parse(m.date) : new Date(m.date).getTime());

function incoming(box: Box, accountId: number, m: Mail, read: boolean): IncomingMessage {
  const labels = m.sent ? ["SENT"] : ["INBOX", ...(m.gmail && m.gmail !== "primary" ? [`CATEGORY_${m.gmail.toUpperCase()}`] : ["CATEGORY_PERSONAL"])];
  return msg({
    accountId,
    providerMsgId: `${box.id}-${m.id}`,
    providerThreadId: `${box.id}-${m.thread}`,
    rfcMessageId: `${box.id}-${m.id}@panel.example`,
    from: m.from,
    to: m.to,
    cc: m.cc ?? [],
    subject: m.subject,
    date: atOf(m),
    snippet: m.text.slice(0, 160).replace(/\s+/g, " "),
    bodyText: m.text,
    bodyHtml: null,
    bodyState: "full",
    listId: m.list ?? null,
    bulk: !!m.bulk,
    isRead: m.sent || read,
    inInbox: !m.sent,
    isSent: !!m.sent,
    gmailLabels: labels,
  });
}

async function drained(backend: Backend): Promise<void> {
  for (let i = 0; i < 2400; i++) {
    const dated = await backend.store.dated.marks.count();
    const sent = await backend.store.followups.marks.count();
    const summaries = await backend.store.aiSummaries.pendingCount();
    if (!dated && !sent && !summaries) return;
    backend.dated.wake({ network: true });
    backend.followups.wake({ network: true });
    backend.summaries.wake({ network: true });
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the readers didn't finish");
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

/**
 * What the AI read the mailbox with: a kept database is reused only while all of it is still what the code would use,
 * the mailbox, its filler and its answer key as they are on disk, and the zone it was read in (plan 210).
 */
const manifestOf = (id: string) => ({
  mail: 3,
  dated: DATED_PROMPT_VERSION,
  followups: FOLLOWUP_PROMPT_VERSION,
  summaries: SUMMARY_PROMPT_VERSION,
  summariesOn: true,
  phases: [PHASE_ONE, NOW],
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  mailbox: sha(mailFile(id, "")),
  filler: sha(mailFile(id, ".filler")),
  key: sha(mailFile(id, ".key")),
});

/** The second morning's: Friday's reading it went on from, and Friday's acts, the night's mail and Saturday's key as on disk. */
const manifestOfDay2 = (id: string) => ({
  friday: manifestOf(id),
  day2: 1,
  morning: SATURDAY,
  day1: sha(mailFile(id, ".day1")),
  incoming: sha(mailFile(id, ".day2")),
  key: sha(mailFile(id, ".key.day2")),
});

/** A day key in the run's zone (the persona's), as the app's. */
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** What a row or its Also line shows, by identity (plan 210): a dated item or a promise of yours, and the mail it's from. */
interface Shown { source: "dated" | "promise"; id: number; kind: string; dueDay: string; messageId: number; text: string }

const shownDated = (r: DatedRow): Shown => ({ source: "dated", id: r.id, kind: r.kind, dueDay: r.dueDay, messageId: r.messageId, text: r.text });
const shownPromise = (p: FollowupRow): Shown => ({ source: "promise", id: p.id, kind: "promise", dueDay: dayOf(p.dueAt), messageId: p.messageId, text: p.text });

/** The row's own item: what its D, Done and Later act on. A waiting row or a reminder has none. */
function ownOf(i: TodayItem, dated: ReadonlyMap<number, DatedRow>, promises: ReadonlyMap<number, FollowupRow>): Shown | null {
  if (i.why.item) {
    const r = dated.get(i.why.item.id);
    return r ? shownDated(r) : { source: "dated", id: i.why.item.id, kind: i.why.item.kind, dueDay: i.why.item.dueDay, messageId: -1, text: i.why.text ?? "" };
  }
  if (i.why.kind === "promise" && i.why.promise) {
    const p = promises.get(i.why.promise.id);
    return p ? shownPromise(p) : null;
  }
  return null;
}

/** An Also line names no id: the open item of the row's conversation it was made from (same kind, words and day). */
function alsoOf(threadId: number, a: TodayAlso, rows: readonly DatedRow[], promises: readonly FollowupRow[]): Shown & { found: boolean } {
  const hit = a.kind === "promise" ? promises.find((p) => p.threadId === threadId && p.text === a.text && dayOf(p.dueAt) === a.dueDay) : rows.find((r) => r.threadId === threadId && r.kind === a.kind && r.text === a.text && r.dueDay === a.dueDay);
  if (!hit) return { source: a.kind === "promise" ? "promise" : "dated", id: -1, kind: a.kind, dueDay: a.dueDay, messageId: -1, text: a.text, found: false };
  return { ...("sentAt" in hit ? shownPromise(hit) : shownDated(hit)), found: true };
}

/**
 * Plan 210 (iteration 3): each request's answer, beside the database (`readings.jsonl`), so a miss is traced to the model or
 * the app's checks. Only what the model was given and said: the system prompt's first line, the last message's text (the
 * mail, the persona's own fixture), the answer; never a header or a key (the transport sees neither).
 */
function loggedCreate(dir: string): typeof createAi {
  const file = join(dir, "readings.jsonl");
  const logged = (t: ModelTransport): ModelTransport => ({
    ...t,
    async complete(req) {
      const out = await t.complete(req);
      const system = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
      const last = req.messages[req.messages.length - 1];
      const input = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      appendFileSync(file, `${JSON.stringify({ task: system.split("\n", 1)[0]!.slice(0, 120), input: input.slice(0, 6000), output: out.text, stop: out.stop })}\n`);
      return out;
    },
  });
  return (config, options) => createAi(config, { ...options, wrapTransport: (t) => logged(options?.wrapTransport ? options.wrapTransport(t) : t) });
}

/**
 * What Today shows, written beside the database: the packets' and the item scorer's source. Each section with its day,
 * each row with its own item and its Also line by identity (plan 210: scored by item, never by conversation). The second
 * morning's also has the history's first page (Earlier): what Friday's acts and the night's mail closed.
 */
async function writeToday(backend: Backend, client: RpcClient, dir: string, persona: string, at = NOW, withHistory = false) {
  const list = await client.call("today.list", { held: [], ...(withHistory && { history: { through: null } }) });
  const rows = await backend.store.dated.active();
  const followups = await backend.store.followups.active();
  const dated = new Map(rows.map((r) => [r.id, r]));
  const promises = new Map(followups.map((p) => [p.id, p]));
  const section = (x: TodaySection) => ({
    kind: x.kind,
    day: x.day ?? null,
    part: x.part ?? null,
    bucket: x.bucket ?? null,
    items: x.items.map((i) => ({ id: i.id, threadId: i.thread.id, from: i.thread.fromName, subject: i.thread.subject, snippet: i.thread.snippet, why: i.why, summary: i.summary ?? null, own: ownOf(i, dated, promises), also: i.also ? i.also.map((a) => ({ ...a, ...alsoOf(i.thread.id, a, rows, followups) })) : null })),
  });
  const history = list.history?.items.map((h) => ({ id: h.id, item: h.item, threadId: h.thread.id, from: h.thread.fromName, subject: h.thread.subject, outcome: h.outcome, kind: h.kind, text: h.text, at: h.key.at, on: h.on ?? null, reason: h.reason ?? null }));
  writeFileSync(join(dir, "today.json"), JSON.stringify({ persona, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, at: new Date(at).toString(), sections: list.sections.map(section), ...(history && { history }), dated: rows, followups }, null, 2));
  return { list, rows };
}

/**
 * The panel, faster (the owner, after the third round): when nothing the AI reads changed, the AI's database is kept and
 * only Today's list is made again from it with the current code, at the packet's morning; no key, no request.
 */
describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST !== "1")("What matters again, on each persona's kept database", () => {
  for (const id of ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]) {
    it(id, { timeout: 300_000 }, async () => {
      // the second morning's database relists at Saturday's morning
      const dir = join(DAY2 ? DB2 : DB, id);
      const morning = DAY2 ? SATURDAY : NOW;
      const kept = existsSync(join(dir, "manifest.json")) ? readFileSync(join(dir, "manifest.json"), "utf8") : null;
      if (kept !== JSON.stringify(DAY2 ? manifestOfDay2(id) : manifestOf(id))) throw new Error(`${id}: the kept database was read with other prompts, mail, keys, zone or settings (${kept ?? "no manifest"}); read the mailbox again`);
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, now: () => morning });
      await backend.store.ready;
      await backend.ready;
      try {
        const [c, s] = createMemoryTransportPair();
        backend.connect(s, { clientId: "renderer", origin: "renderer" });
        const client = new RpcClient(c);
        backend.today.touched();
        const { list, rows } = await writeToday(backend, client, dir, id, morning, DAY2);
        console.log(`${id} (relisted):${list.sections.map((x) => `${x.kind} ${x.items.length}`).join(", ")}; ${rows.length} dated open`);
      } finally {
        await backend.stop();
      }
    });
  }
});

describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST === "1" || DAY2)("What matters, on each persona's mailbox", () => {
  const boxes = (ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]).map((id) => JSON.parse(readFileSync(join(DIR, "mail", `${id}.json`), "utf8")) as Box);
  for (const box of boxes) {
    it(box.id, { timeout: 1_800_000 }, async () => {
      const dir = join(DB, box.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // the clock runs from where it's set, as a wall clock would: the limiter's minute is measured on it, and a stopped
      // clock holds the 21st request of a minute for good
      const clock = { base: PHASE_ONE, from: Date.now(), set(at: number) { this.base = at; this.from = Date.now(); } };
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: heldKeys(), providers: demoRegistry, autoSync: false, aiFactory: realAiFactory(loggedCreate(dir)), now: () => clock.base + (Date.now() - clock.from) });
      await backend.store.ready;
      await backend.ready;
      try {
        const [c, s] = createMemoryTransportPair();
        backend.connect(s, { clientId: "renderer", origin: "renderer" });
        const client = new RpcClient(c);
        const { account } = await backend.store.accounts.create({ kind: "gmail", email: box.me.email, displayName: box.me.name, color: "brown", now: 0 });
        const keys = realKeys();
        await client.call("ai.setKey", { provider: "anthropic", value: keys.anthropic });
        await client.call("ai.setKey", { provider: "openai", value: keys.openai });
        // the harness's own check that a failed run leaves no key behind (plan 210): a throw, or the process killed outright
        if (process.env.TERNO_PANEL_FAIL === "after-keys") throw new Error("failed on purpose, after the keys were set");
        if (process.env.TERNO_PANEL_FAIL === "kill-after-keys") process.kill(process.pid, "SIGKILL");
        // both keys: Pro's routing (the dated reader on Luna); summaries on, as the app's default (Needs you reads them)
        await client.call("settings.update", { ai: { provider: "anthropic" }, language: box.language, summaries: { enabled: true } });
        await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
        const all = [...box.messages, ...fillerOf(box.id)].sort((x, y) => atOf(x) - atOf(y));
        const first = all.filter((m) => atOf(m) <= PHASE_ONE);
        const rest = all.filter((m) => atOf(m) > PHASE_ONE);
        // phase one: what was already here when it was turned on, then the 14-day check and follow-ups' 30 days
        await backend.ingestSliced(first.map((m) => incoming(box, account.id, m, atOf(m) < PHASE_ONE - 2 * DAY)), false);
        expect(await backend.dated.scan()).toBeGreaterThan(0);
        await backend.followups.scan();
        await client.call("settings.update", { dated: { scanAnswered: true }, followups: { scanAnswered: true } });
        await drained(backend);
        // phase two: the rest as it arrives, on the morning it's opened
        clock.set(NOW - 30 * 60_000);
        for (const m of rest) {
          await backend.ingestSliced([incoming(box, account.id, m, false)], false, undefined, undefined, undefined, undefined, undefined, true);
        }
        await drained(backend);
        clock.set(NOW);
        backend.today.touched();
        const { list, rows } = await writeToday(backend, client, dir, box.id);
        await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestOf(box.id)));
        console.log(`${box.id}: ${list.sections.map((x) => `${x.kind} ${x.items.length}`).join(", ")}; ${rows.length} dated open; ${spendReport()}`);
      } finally {
        // the copy keeps not even a handle, however the run ended: the app opens it on the demo's provider
        for (const name of await backend.store.secrets.names().catch(() => [])) await backend.store.secrets.delete(name).catch(() => {});
        await backend.stop();
      }
    });
  }
});

/** The second morning's Friday (plan 210): what the persona did on the feed, by the item's source mail and kind. */
interface Day1Action { at: string; message: string; kind: string; do: "done" | "remove" | "later" | "change"; until?: string; day?: string; time?: string | null; why: string }
/** …and the mail they sent, a reply in its conversation (`replyTo`, a fixture id), at its moment. */
interface Day1Sent { id: string; replyTo: string; thread: string; at: string; to: Person[]; cc?: Person[]; subject: string; text: string; why: string }
interface Day1 { id: string; actions: Day1Action[]; sent: Day1Sent[] }

/** An item's family, as the panel's scorer matches them: a promise of yours, a plan, or a task. */
const familyOf = (kind: string): string => (kind === "promise" ? "promise" : kind === "event" || kind === "delivery" ? "plan" : "task");

const localAt = (s: string): number => new Date(s).getTime();

describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST === "1" || !DAY2)("What matters the morning after, on each persona's Friday", () => {
  for (const id of ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]) {
    it(id, { timeout: 3_600_000 }, async () => {
      const box = JSON.parse(readFileSync(mailFile(id, ""), "utf8")) as Box;
      const day1 = JSON.parse(readFileSync(mailFile(id, ".day1"), "utf8")) as Day1;
      const night = (JSON.parse(readFileSync(mailFile(id, ".day2"), "utf8")) as { messages: Mail[] }).messages;
      // Friday's reading, as the code would still make it: the morning after goes on from that one alone
      const base = join(DB, id);
      const kept = existsSync(join(base, "manifest.json")) ? readFileSync(join(base, "manifest.json"), "utf8") : null;
      if (kept !== JSON.stringify(manifestOf(id))) throw new Error(`${id}: Friday's database was read with other prompts, mail, keys, zone or settings (${kept ?? "no manifest"}); read Friday again first`);
      const dir = join(DB2, id);
      rmSync(dir, { recursive: true, force: true });
      cpSync(base, dir, { recursive: true });
      for (const f of ["today.json", "manifest.json"]) rmSync(join(dir, f), { force: true });
      if (existsSync(join(dir, "readings.jsonl"))) renameSync(join(dir, "readings.jsonl"), join(dir, "readings.day1.jsonl"));
      // the clock from Friday's morning on, running as a wall clock would (the limiter's minute), moved to each event's
      // moment and never back
      const clock = {
        base: NOW,
        from: Date.now(),
        now() {
          return this.base + (Date.now() - this.from);
        },
        set(at: number) {
          this.base = Math.max(at, this.now());
          this.from = Date.now();
        },
      };
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: heldKeys(), providers: demoRegistry, autoSync: false, aiFactory: realAiFactory(loggedCreate(dir)), now: () => clock.now() });
      await backend.store.ready;
      await backend.ready;
      const ro = new DatabaseSync(join(dir, "terno.db"), { readOnly: true });
      try {
        const [c, s] = createMemoryTransportPair();
        backend.connect(s, { clientId: "renderer", origin: "renderer" });
        const client = new RpcClient(c);
        const account = (await backend.store.accounts.list())[0]!;
        const keys = realKeys();
        await client.call("ai.setKey", { provider: "anthropic", value: keys.anthropic });
        await client.call("ai.setKey", { provider: "openai", value: keys.openai });
        await client.call("settings.update", { ai: { provider: "anthropic" } });
        // a fixture's message to the database's: the mailbox's by its provider id, Friday's sent mail by what its send made
        const sentIds = new Map<string, number>();
        const lookup = ro.prepare("select id from messages where provider_msg_id = ?");
        const idOf = (fixture: string): number | undefined => sentIds.get(fixture) ?? (lookup.get(`${box.id}-${fixture}`) as { id: number } | undefined)?.id;
        const log: object[] = [];

        /** One of Friday's acts, as the feed's row makes it: on the row's own item, at the revision the row shows. */
        async function act(a: Day1Action): Promise<string> {
          const messageId = idOf(a.message);
          if (messageId === undefined) return "skipped: no such message";
          const rows = (await client.call("today.list", { held: [] })).sections.flatMap((x) => x.items);
          let target: { source: "dated" | "promise"; id: number; revision: number; text: string; with?: { source: "dated" | "promise"; id: number; revision: number }[] } | null = null;
          if (a.kind === "promise") {
            const open = (await backend.store.followups.active()).filter((p) => p.messageId === messageId);
            const row = rows.find((i) => i.why.kind === "promise" && i.why.promise && open.some((p) => p.id === i.why.promise!.id));
            const p = row ? open.find((x) => x.id === row.why.promise!.id)! : open[0];
            if (p) target = { source: "promise", id: p.id, revision: row?.why.promise!.revision ?? p.revision, text: p.text, ...(row?.why.with && { with: row.why.with }) };
          } else {
            // the item of that kind before one of its family; the one a row shows before one it doesn't
            const open = (await backend.store.dated.active()).filter((r) => r.messageId === messageId && familyOf(r.kind) === familyOf(a.kind)).sort((x, y) => Number(y.kind === a.kind) - Number(x.kind === a.kind));
            const r = open.find((x) => rows.some((i) => i.why.item?.id === x.id)) ?? open[0];
            if (r) target = { source: "dated", id: r.id, revision: rows.find((i) => i.why.item?.id === r.id)?.why.item?.revision ?? r.revision, text: r.text };
          }
          if (!target) return "skipped: no open item of that kind (closed by mail already, or not read so)";
          if (a.do === "change") {
            await client.call("today.schedule", { item: { source: target.source, id: target.id, revision: target.revision }, to: { day: a.day!, time: a.time ?? null } });
          } else {
            const action = a.do === "remove" ? "dismiss" : a.do;
            const until = a.until ? localAt(a.until) : undefined;
            if (target.source === "dated") await client.call("dated.act", { id: target.id, revision: target.revision, action, ...(action === "later" && { until }) });
            else await client.call("followups.act", { id: target.id, revision: target.revision, action, ...(action === "later" && { dueAt: until }), ...(target.with && { with: target.with }) });
          }
          return `${a.do} ${target.source}#${target.id}: ${target.text}`;
        }

        /** Friday's mail, sent as the app sends it: a reply through the outbox, whose sent copy the follow-ups read. */
        async function send(m: Day1Sent): Promise<string> {
          const inReplyToMessageId = idOf(m.replyTo);
          if (inReplyToMessageId === undefined) throw new Error(`${m.id} replies to ${m.replyTo}, which isn't in the database`);
          const sent = await client.call("compose.send", { accountId: account.id, to: m.to, cc: m.cc ?? [], bcc: [], subject: m.subject, bodyText: m.text, inReplyToMessageId });
          // autoSync is off: the outbox's worker runs here, as the app's runs once a send is queued (the demo provider takes it)
          if ((await backend.runWorker()) < 1) throw new Error(`${m.id} wasn't sent`);
          sentIds.set(m.id, sent.messageId);
          await drained(backend);
          return `sent as message ${sent.messageId} in thread ${sent.threadId}`;
        }

        /** The night's mail, live, as it arrives. */
        async function arrive(m: Mail): Promise<string> {
          await backend.ingestSliced([incoming(box, account.id, m, false)], false, undefined, undefined, undefined, undefined, undefined, true);
          await drained(backend);
          return "arrived";
        }

        // Friday after the morning's look, then the night: each at its own moment; at the same minute a send, then an act
        const events = [
          ...day1.sent.map((m) => ({ at: localAt(m.at), order: 0, what: `${m.id} (sent)`, run: () => send(m) })),
          ...day1.actions.map((a) => ({ at: localAt(a.at), order: 1, what: `${a.message} ${a.kind} (${a.do})`, run: () => act(a) })),
          ...night.map((m) => ({ at: atOf(m), order: 2, what: `${m.id} (${m.from.name})`, run: () => arrive(m) })),
        ].sort((x, y) => x.at - y.at || x.order - y.order);
        for (const e of events) {
          clock.set(e.at);
          const result = await e.run().catch((error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`);
          log.push({ at: new Date(e.at).toString(), event: e.what, result });
          console.log(`${id} ${dayOf(e.at)} ${new Date(e.at).toTimeString().slice(0, 5)} ${e.what}: ${result}`);
        }
        await drained(backend);
        clock.set(SATURDAY);
        backend.today.touched();
        const { list, rows } = await writeToday(backend, client, dir, id, SATURDAY, true);
        // beside the database, for the panel's tools: the sent copies' fixture ids, and what each of Friday's events did
        writeFileSync(join(dir, "sent-ids.json"), JSON.stringify(Object.fromEntries([...sentIds].map(([fixture, message]) => [message, fixture])), null, 2));
        writeFileSync(join(dir, "day1-applied.json"), JSON.stringify(log, null, 2));
        await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestOfDay2(id)));
        console.log(`${id} (Saturday): ${list.sections.map((x) => `${x.kind} ${x.items.length}`).join(", ")}; ${list.history?.items.length ?? 0} in Earlier; ${rows.length} dated open; ${spendReport()}`);
      } finally {
        ro.close();
        // as Friday's: no key nor handle left behind, however the run ended
        for (const name of await backend.store.secrets.names().catch(() => [])) await backend.store.secrets.delete(name).catch(() => {});
        await backend.stop();
      }
    });
  }
});
