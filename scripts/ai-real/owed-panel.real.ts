import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { Backend, plaintextCipher, type SecretCipher } from "../../packages/backend/src/backend";
import { createMemoryTransportPair, RpcClient } from "../../packages/core/src/rpc";
import { demoRegistry } from "../../packages/mail/src";
import type { IncomingMessage } from "../../packages/store/src";
import { msg } from "../../packages/store/src/conformance/fixtures";
import { realAiFactory } from "../../apps/backend-dev/src/real-ai";
import { createAi, type ModelTransport } from "../../packages/ai/src";
import { realKeys, spendReport } from "./harness";

/**
 * Plan 280's QA panel: each persona's fictional mailbox (outside the repo, TERNO_PANEL_DIR/mail/<id>.json, written for that
 * persona), read by the follow-ups reader and the dated reader on real models under the spend ledger, as the app would:
 * what was already there when Follow-ups went on (Tuesday 2026-11-10 09:00) through the checks, the rest as live mail at
 * its own moment, then the persona opens Terno on Friday 2026-11-13 09:30. What Follow-ups holds is written beside the
 * database (`owed.json`) for the capture and the reviewers. Keys live only in this process (`heldKeys`); the copy is left
 * on the demo's provider, so the app opens it with no key. Nothing reaches a mail server. Run alone, one persona at a
 * time in their zone: TERNO_AI_REAL=1 TERNO_OWED_PANEL=1 TERNO_PANEL_ONLY=<id> TZ=<zone>.
 */
const DIR = process.env.TERNO_PANEL_DIR ?? "/tmp/terno-scratch/p280/panel";
const ONLY = process.env.TERNO_PANEL_ONLY?.split(",") ?? ["theo", "priya", "maria", "diego", "jordan", "margaret", "sam"];
const TURNED_ON = new Date(2026, 10, 10, 9, 0).getTime();
const MORNING = new Date(2026, 10, 13, 9, 30).getTime();

interface Person { name: string; email: string }
interface Mail { id: string; thread: string; from: Person; to: Person[]; cc?: Person[]; subject: string; date: string; text: string; sent?: boolean; list?: string | null; bulk?: boolean; gmail?: string; files?: string[] }
interface Box { id: string; me: Person; language: "en" | "es"; zone: string; messages: Mail[] }

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

/** Each request's task, input and answer beside the database: a miss is traced to the model or the app's checks. */
function loggedCreate(dir: string): typeof createAi {
  const file = join(dir, "readings.jsonl");
  const logged = (t: ModelTransport): ModelTransport => ({
    ...t,
    async complete(req) {
      const out = await t.complete(req);
      const system = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
      const last = req.messages[req.messages.length - 1];
      const input = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      appendFileSync(file, `${JSON.stringify({ task: system.split("\n", 1)[0]!.slice(0, 120), input: input.slice(0, 6000), output: out.text })}\n`);
      return out;
    },
  });
  return (config, options) => createAi(config, { ...options, wrapTransport: (t) => logged(options?.wrapTransport ? options.wrapTransport(t) : t) });
}

const atOf = (m: Mail): number => new Date(m.date).getTime();

function incoming(box: Box, accountId: number, m: Mail, read: boolean): IncomingMessage {
  const labels = m.sent ? ["SENT"] : ["INBOX", m.gmail && m.gmail !== "primary" ? `CATEGORY_${m.gmail.toUpperCase()}` : "CATEGORY_PERSONAL"];
  const files = (m.files ?? []).map((filename) => ({ filename, mime: filename.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", size: 4, bytes: new Uint8Array([37, 80, 68, 70]) }));
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
    isRead: !!m.sent || read,
    inInbox: !m.sent,
    isSent: !!m.sent,
    gmailLabels: labels,
    ...(files.length ? { hasAttachments: true, attachments: files } : {}),
  });
}

/** A conversation's earlier messages, so a reply threads under what it answers (In-Reply-To and References). */
function threaded(box: Box, m: Mail): Partial<IncomingMessage> {
  const before = box.messages.filter((x) => x.thread === m.thread && atOf(x) < atOf(m));
  const ids = before.map((x) => `${box.id}-${x.id}@panel.example`);
  return ids.length ? { inReplyTo: ids.at(-1)!, references: ids } : {};
}

async function drained(backend: Backend): Promise<void> {
  for (let i = 0; i < 2400; i++) {
    const owed = await backend.store.followups.owed.marks.count();
    const sent = await backend.store.followups.marks.count();
    const dated = await backend.store.dated.marks.count();
    if (!owed && !sent && !dated) return;
    backend.dated.wake({ network: true });
    backend.followups.wake({ network: true });
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the readers didn't finish");
}

describe.skipIf(process.env.TERNO_OWED_PANEL !== "1")("Owed to you, on each persona's mailbox (plan 280)", () => {
  for (const id of ONLY) {
    it(id, { timeout: 1_800_000 }, async () => {
      const box = JSON.parse(readFileSync(join(DIR, "mail", `${id}.json`), "utf8")) as Box;
      const dir = join(DIR, "db", id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // a running clock: the limiter's minute is measured on it
      const clock = { base: TURNED_ON, from: Date.now(), set(at: number) { this.base = at; this.from = Date.now(); } };
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
        await client.call("settings.update", { ai: { provider: "anthropic" }, language: box.language, summaries: { enabled: false } });
        await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
        const mail = [...box.messages].sort((x, y) => atOf(x) - atOf(y));
        const ingest = (m: Mail, live: boolean) => backend.ingestSliced([{ ...incoming(box, account.id, m, !live && atOf(m) < TURNED_ON - 2 * 86_400_000), ...threaded(box, m) }], false, undefined, undefined, undefined, undefined, undefined, live);
        // what was here when Follow-ups went on: the checks read it
        for (const m of mail.filter((x) => atOf(x) <= TURNED_ON)) await ingest(m, false);
        await backend.store.accounts.setSyncState(account.id, { lastSyncAt: TURNED_ON });
        await backend.dated.start();
        await backend.followups.start();
        await backend.dated.checkAccounts([account.id]);
        await backend.followups.checkAccounts([account.id]);
        await drained(backend);
        // the rest as it arrives, each at its own moment
        for (const m of mail.filter((x) => atOf(x) > TURNED_ON)) {
          clock.set(atOf(m) + 60_000);
          await ingest(m, true);
          await drained(backend);
        }
        clock.set(MORNING);
        await backend.followups.look();
        const active = await backend.store.followups.active();
        // what closed by itself too (kept, withdrawn, retired), straight from the file: the reviewers judge those as well
        const db = new DatabaseSync(join(dir, "terno.db"), { readOnly: true });
        const all = db.prepare("SELECT f.id, f.kind, f.state, f.closed_reason, f.text, f.quote, f.person_name, f.person_email, f.due_day, f.due_at, f.dated, f.firm, f.from_scan, f.inbox_state, f.arrived_hint, f.moved_at, f.settled_by, f.sent_at, m.provider_msg_id AS source, s.provider_msg_id AS settled FROM followups f LEFT JOIN messages m ON m.id = f.message_id LEFT JOIN messages s ON s.id = f.settled_by ORDER BY f.id").all();
        db.close();
        writeFileSync(join(dir, "owed.json"), JSON.stringify({ persona: id, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, at: new Date(MORNING).toString(), active, all }, null, 2));
        await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
        console.log(`${id}: ${active.length} active (${active.filter((r) => r.kind === "theirs").length} theirs), ${all.length} in all; ${spendReport()}`);
      } finally {
        for (const name of await backend.store.secrets.names().catch(() => [])) await backend.store.secrets.delete(name).catch(() => {});
        await backend.stop();
      }
    });
  }
});

void plaintextCipher;
