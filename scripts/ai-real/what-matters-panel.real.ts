import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { DATED_PROMPT_VERSION, FOLLOWUP_PROMPT_VERSION, SUMMARY_PROMPT_VERSION } from "../../packages/ai/src";
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
 */
const DIR = process.env.TERNO_PANEL_DIR ?? "/tmp/terno-scratch/p204/panel";
/** where each persona's database goes (a proof run keeps its own, beside the round's) */
const DB = process.env.TERNO_PANEL_DB ?? join(DIR, "db");
const ONLY = process.env.TERNO_PANEL_ONLY?.split(",");
const PHASE_ONE = new Date(2026, 10, 10, 9, 0).getTime();
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
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
 * What Today shows, written beside the database: the packets' and the item scorer's source. Each section with its day,
 * each row with its own item and its Also line by identity (plan 210: scored by item, never by conversation).
 */
async function writeToday(backend: Backend, client: RpcClient, dir: string, persona: string) {
  const list = await client.call("today.list", { heldIds: [] });
  const rows = await backend.store.dated.active();
  const followups = await backend.store.followups.active();
  const dated = new Map(rows.map((r) => [r.id, r]));
  const promises = new Map(followups.map((p) => [p.id, p]));
  const section = (x: TodaySection) => ({
    kind: x.kind,
    day: x.day ?? null,
    items: x.items.map((i) => ({ threadId: i.thread.id, from: i.thread.fromName, subject: i.thread.subject, snippet: i.thread.snippet, why: i.why, summary: i.summary ?? null, own: ownOf(i, dated, promises), also: i.also ? { ...i.also, ...alsoOf(i.thread.id, i.also, rows, followups) } : null })),
  });
  writeFileSync(join(dir, "today.json"), JSON.stringify({ persona, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, at: new Date(NOW).toString(), sections: list.sections.map(section), dated: rows, followups }, null, 2));
  return { list, rows };
}

/**
 * The panel, faster (the owner, after the third round): when nothing the AI reads changed, the AI's database is kept and
 * only Today's list is made again from it with the current code, at the packet's morning; no key, no request.
 */
describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST !== "1")("What matters again, on each persona's kept database", () => {
  for (const id of ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]) {
    it(id, { timeout: 300_000 }, async () => {
      const dir = join(DB, id);
      const kept = existsSync(join(dir, "manifest.json")) ? readFileSync(join(dir, "manifest.json"), "utf8") : null;
      if (kept !== JSON.stringify(manifestOf(id))) throw new Error(`${id}: the kept database was read with other prompts, mail, keys, zone or settings (${kept ?? "no manifest"}); read the mailbox again`);
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, now: () => NOW });
      await backend.store.ready;
      await backend.ready;
      try {
        const [c, s] = createMemoryTransportPair();
        backend.connect(s, { clientId: "renderer", origin: "renderer" });
        const client = new RpcClient(c);
        backend.today.touched();
        const { list, rows } = await writeToday(backend, client, dir, id);
        console.log(`${id} (relisted): ${list.sections.map((x) => `${x.kind} ${x.items.length}`).join(", ")}; ${rows.length} dated open`);
      } finally {
        await backend.stop();
      }
    });
  }
});

describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST === "1")("What matters, on each persona's mailbox", () => {
  const boxes = (ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]).map((id) => JSON.parse(readFileSync(join(DIR, "mail", `${id}.json`), "utf8")) as Box);
  for (const box of boxes) {
    it(box.id, { timeout: 1_800_000 }, async () => {
      const dir = join(DB, box.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // the clock runs from where it's set, as a wall clock would: the limiter's minute is measured on it, and a stopped
      // clock holds the 21st request of a minute for good
      const clock = { base: PHASE_ONE, from: Date.now(), set(at: number) { this.base = at; this.from = Date.now(); } };
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: heldKeys(), providers: demoRegistry, autoSync: false, aiFactory: realAiFactory(), now: () => clock.base + (Date.now() - clock.from) });
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
