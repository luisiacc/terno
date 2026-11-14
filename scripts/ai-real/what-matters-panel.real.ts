import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "../../packages/backend/src/backend";
import { createMemoryTransportPair, RpcClient } from "../../packages/core/src/rpc";
import { demoRegistry } from "../../packages/mail/src";
import type { IncomingMessage } from "../../packages/store/src";
import { msg } from "../../packages/store/src/conformance/fixtures";
import { realAiFactory } from "../../apps/backend-dev/src/real-ai";
import { DATED_PROMPT_VERSION, FOLLOWUP_PROMPT_VERSION, SUMMARY_PROMPT_VERSION } from "../../packages/ai/src";
import { realKeys, spendReport } from "./harness";

/**
 * Plan 204's user panel: each persona's mailbox (fictional, outside the repo under TERNO_PANEL_DIR/mail) with real mail
 * from the eval corpus (~/.terno-evals/real-mail-fresh, never in the repo) moved into the same two weeks, read by the real
 * dated reader and follow-ups on real models, under the spend ledger. In two phases, so Missed is real: the 14-day check
 * on Tuesday 2026-11-10 09:00, then the rest as live mail on Friday 2026-11-13 09:00. What Today shows is written beside
 * the database; the keys are removed from the copy and its provider set to the demo's, so the app opens it with no key.
 * Nothing reaches a mail server (the demo registry, no sync). Run alone: TERNO_AI_REAL=1 TERNO_PANEL=1.
 */
const DIR = process.env.TERNO_PANEL_DIR ?? "/tmp/terno-scratch/p204/panel";
const ONLY = process.env.TERNO_PANEL_ONLY?.split(",");
const REAL = join(homedir(), ".terno-evals", "real-mail-fresh");
const PHASE_ONE = new Date(2026, 10, 10, 9, 0).getTime();
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
const DAY = 86_400_000;

interface Person { name: string; email: string }
interface Mail { id: string; thread: string; from: Person; to: Person[]; cc?: Person[]; subject: string; date: string; text: string; sent?: boolean; list?: string | null; bulk?: boolean; gmail?: string }
interface Box { id: string; me: Person; language: "en" | "es"; messages: Mail[] }

/** which real conversations each persona gets, as background: their kind of mail */
const REAL_MAIL: Record<string, { file: string; n: number }[]> = {
  theo: [{ file: "apache.jsonl", n: 10 }],
  jordan: [{ file: "enron.jsonl", n: 12 }],
  priya: [{ file: "enron.jsonl", n: 10 }],
  maria: [{ file: "enron.jsonl", n: 4 }],
  margaret: [{ file: "enron.jsonl", n: 3 }],
  sam: [{ file: "apache.jsonl", n: 8 }],
  diego: [{ file: "python-es.jsonl", n: 6 }, { file: "debian-es.jsonl", n: 4 }],
};

const parseAddress = (s: string): Person => {
  const m = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(s);
  return m ? { name: m[1]!, email: m[2]!.toLowerCase() } : { name: "", email: s.trim().toLowerCase() };
};

/** A real conversation, moved by whole weeks into the two weeks before NOW (its weekdays stay right), to the persona. */
function realMail(box: Box, seed: number): Mail[] {
  const out: Mail[] = [];
  let k = seed;
  for (const { file, n } of REAL_MAIL[box.id] ?? []) {
    const path = join(REAL, file);
    if (!existsSync(path)) continue;
    const all = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; subject: string; reader: Person; messages: { from: string; date: string; own: boolean; to: string[]; cc: string[]; list?: boolean; text: string }[] });
    for (let i = 0; i < n && all.length; i++) {
      k = (k * 1103515245 + 12345) % 2 ** 31;
      const c = all.splice(k % all.length, 1)[0]!;
      const last = new Date(`${c.messages.at(-1)!.date}T12:00:00`).getTime();
      const weeks = Math.ceil((NOW - DAY - last) / (7 * DAY));
      const shift = weeks * 7 * DAY - (k % 2 ? 0 : 7 * DAY);
      c.messages.forEach((m, j) => {
        const at = new Date(`${m.date}T${String(8 + ((k + j) % 9)).padStart(2, "0")}:${String((k * 7 + j * 13) % 60).padStart(2, "0")}:00`).getTime() + shift;
        if (at > NOW - 30 * 60_000) return;
        const me = (s: string) => (s.toLowerCase().includes(c.reader.email.toLowerCase()) ? box.me : parseAddress(s));
        out.push({
          id: `${c.id}-${j}`,
          thread: c.id,
          from: m.own ? box.me : parseAddress(m.from),
          to: m.to.length ? m.to.map(me) : [box.me],
          cc: m.cc.map(me),
          subject: j ? `Re: ${c.subject}` : c.subject,
          date: new Date(at).toISOString(),
          text: m.text,
          sent: m.own,
          list: m.list ? `${file.replace(".jsonl", "")}.lists.example` : null,
          bulk: !!m.list,
          gmail: m.list ? "forums" : "primary",
        });
      });
    }
  }
  return out;
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

/** What the AI read the mailbox with: a kept database is reused only while all of it is still what the code would use. */
const MANIFEST = { dated: DATED_PROMPT_VERSION, followups: FOLLOWUP_PROMPT_VERSION, summaries: SUMMARY_PROMPT_VERSION, summariesOn: true, phases: [PHASE_ONE, NOW] };

/** What Today shows, written beside the database: the packet's source. */
async function writeToday(backend: Backend, client: RpcClient, dir: string, persona: string) {
  const list = await client.call("today.list", { heldIds: [] });
  const rows = await backend.store.dated.active();
  writeFileSync(join(dir, "today.json"), JSON.stringify({ persona, at: new Date(NOW).toString(), sections: list.sections.map((x) => ({ kind: x.kind, items: x.items.map((i) => ({ threadId: i.thread.id, from: i.thread.fromName, subject: i.thread.subject, snippet: i.thread.snippet, why: i.why, summary: i.summary ?? null })) })), dated: rows, followups: await backend.store.followups.active() }, null, 2));
  return { list, rows };
}

/**
 * The panel, faster (the owner, after the third round): when nothing the AI reads changed, the AI's database is kept and
 * only Today's list is made again from it with the current code, at the packet's morning; no key, no request.
 */
describe.skipIf(process.env.TERNO_PANEL !== "1" || process.env.TERNO_PANEL_RELIST !== "1")("What matters again, on each persona's kept database", () => {
  for (const id of ONLY ?? ["theo", "maria", "diego", "jordan", "margaret", "sam", "priya"]) {
    it(id, { timeout: 300_000 }, async () => {
      const dir = join(DIR, "db", id);
      const kept = existsSync(join(dir, "manifest.json")) ? readFileSync(join(dir, "manifest.json"), "utf8") : null;
      if (kept !== JSON.stringify(MANIFEST)) throw new Error(`${id}: the kept database was read with other prompts or settings (${kept ?? "no manifest"}); read the mailbox again`);
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
  for (const [b, box] of boxes.entries()) {
    it(box.id, { timeout: 1_800_000 }, async () => {
      const dir = join(DIR, "db", box.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // the clock runs from where it's set, as a wall clock would: the limiter's minute is measured on it, and a stopped
      // clock holds the 21st request of a minute for good
      const clock = { base: PHASE_ONE, from: Date.now(), set(at: number) { this.base = at; this.from = Date.now(); } };
      const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "panel", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, aiFactory: realAiFactory(), now: () => clock.base + (Date.now() - clock.from) });
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
        // both keys: Pro's routing (the dated reader on Luna); summaries on, as the app's default (Needs you reads them)
        await client.call("settings.update", { ai: { provider: "anthropic" }, language: box.language, summaries: { enabled: true } });
        await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
        const all = [...box.messages, ...realMail(box, 204 + b)].sort((x, y) => atOf(x) - atOf(y));
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
        // the copy keeps no key: the demo's provider, so the app opens it as it is
        await client.call("ai.setKey", { provider: "anthropic", value: "" });
        await client.call("ai.setKey", { provider: "openai", value: "" });
        await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
        expect(await backend.store.secrets.has("ai:anthropic:apiKey")).toBe(false);
        expect(await backend.store.secrets.has("ai:openai:apiKey")).toBe(false);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST));
        console.log(`${box.id}: ${list.sections.map((x) => `${x.kind} ${x.items.length}`).join(", ")}; ${rows.length} dated open; ${spendReport()}`);
      } finally {
        await backend.stop();
      }
    });
  }
});
