import { appendFileSync, copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { promptText, type CompletionRequest, type ModelTransport } from "@terno/ai";
import { Backend, plaintextCipher } from "../../packages/backend/src/backend";
import { createMemoryTransportPair, RpcClient } from "../../packages/core/src/rpc";
import { demoRegistry } from "../../packages/mail/src";
import { realAiFactory } from "../../apps/backend-dev/src/real-ai";
import { realKeys, realTransport, spendReport } from "./harness";

/**
 * The AI round's own-mail run (plans 141 to 145): each decision on a copy of a real mailbox with its credentials removed,
 * through the real backend on the demo mail registry, so nothing here can reach a mail server. Nothing is ever applied.
 *
 * No mail lives in this file. The copy, the seeds and every decision stay under TERNO_REAL_MAIL_DIR, outside the repo, for
 * a panel to read. Run one phase at a time: TERNO_RT_PHASE=seed|ask|actions|replies|followups|digest|today, TERNO_RT_ROUND=n.
 */
const DIR = process.env.TERNO_REAL_MAIL_DIR ?? "/tmp/terno-scratch/ai6";
const ROUND = process.env.TERNO_RT_ROUND ?? "1";
const OUT = join(DIR, `round-${ROUND}`);
const PHASE = process.env.TERNO_RT_PHASE ?? "";
const SOURCE = join(DIR, "mail", "terno.db");
const clip = (text: unknown, n = 1600) => String(text ?? "").slice(0, n);
const line = (file: string, record: unknown) => appendFileSync(join(OUT, file), `${JSON.stringify(record)}\n`);

interface Call { schema: string | null; prompt: string; response: string }

async function open(phase: string) {
  mkdirSync(OUT, { recursive: true });
  const work = join(OUT, `${phase}.db`);
  // what a run before this one left beside it would corrupt the fresh copy
  for (const leftover of [`${work}-wal`, `${work}-shm`]) rmSync(leftover, { force: true });
  copyFileSync(SOURCE, work);
  const calls: Call[] = [];
  const recording = (transport: ModelTransport): ModelTransport => ({
    ...transport,
    complete: async (req: CompletionRequest) => {
      const prompt = req.messages.map((m) => promptText(m.content)).join("\n\n");
      const r = await transport.complete(req);
      calls.push({ schema: req.schema?.name ?? null, prompt, response: r.text });
      return r;
    },
    ...(transport.stream
      ? {
          stream: async function* (req: CompletionRequest) {
            let response = "";
            for await (const event of transport.stream!(req)) {
              if (event.type === "delta") response += event.text;
              yield event;
            }
            calls.push({ schema: req.schema?.name ?? null, prompt: req.messages.map((m) => promptText(m.content)).join("\n\n"), response });
          },
        }
      : {}),
  });
  const factory = realAiFactory();
  const clock = { now: Date.now() };
  const backend = new Backend({
    dbPath: work,
    version: "round-two",
    cipher: plaintextCipher,
    providers: demoRegistry,
    autoSync: false,
    aiFactory: (config, options) => factory(config, { ...options, wrapTransport: (t) => recording(options.wrapTransport ? options.wrapTransport(t) : t) }),
    now: () => clock.now,
  });
  await backend.store.ready;
  await backend.ready;
  const raw = (backend.store as unknown as { db: { get<T>(s: string, ...a: unknown[]): T; all<T>(s: string, ...a: unknown[]): T[]; run(s: string, ...a: unknown[]): unknown } }).db;
  clock.now = raw.get<{ d: number }>("SELECT max(date) AS d FROM messages WHERE is_sent = 0").d + 3_600_000;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  await client.call("ai.setKey", { provider: "anthropic", value: realKeys().anthropic });
  await client.call("settings.update", { ai: { provider: "anthropic", model: "claude-sonnet-5-5" } });
  const destinations = { ask: null as string | null };
  return { backend, client, clock, raw, calls, destinations };
}

const seeds = () => JSON.parse(readFileSync(join(DIR, "seeds.json"), "utf8")) as { questions: { q: string; expect: string }[]; sentences: { s: string; kind: string }[] };

async function askOnce(client: RpcClient, question: string, acknowledge?: string): Promise<any> {
  const r: any = await client.call("ai.ask", { requestId: crypto.randomUUID(), question, timezone: "America/Mexico_City", ...(acknowledge ? { acknowledge } : {}) } as never);
  return r.status === "consent" ? askOnce(client, question, r.destination) : r;
}

describe.skipIf(!process.env.TERNO_REAL_MAIL)("the AI round on a real mailbox", () => {
  it.runIf(PHASE === "seed")("what to ask of it", { timeout: 300_000 }, async () => {
    const t = await open("seed");
    const recent = t.raw.all<{ s: string; f: string; e: string; sent: number }>("SELECT subject AS s, from_name AS f, from_email AS e, is_sent AS sent FROM messages ORDER BY date DESC LIMIT 400");
    const model = realTransport({ provider: "anthropic", model: "claude-sonnet-5-5" }, "round-two-seed");
    const r = await model.complete({
      system: "You write realistic test inputs.",
      messages: [{ role: "user", content: `These are one person's recent emails (subject | sender). Write test inputs for an email assistant, in the language each person would really use (mostly the mailbox's own languages).

Return only JSON: {"questions":[{"q":"...","expect":"answerable|unknown"}],"sentences":[{"s":"...","kind":"literal|meaning|future|refuse|vague"}]}

- 30 "questions" someone would really ask their own mail: dates, amounts, who said what, what's pending. About 22 that this mail plainly can answer, 8 that it plainly can't (expect "unknown").
- 30 "sentences" commanding the assistant to act on mail: archive, delete, mark spam, mark read, star, send to a category or folder. Mix: literal senders or domains from below, meanings ("shipping notices", "recruiters"), with exceptions and ages, implying future mail ("always", "from now on"). Include 4 it must refuse (forward, unsubscribe, reply, remind) and 3 too vague to act on.

${recent.map((m) => `${m.sent ? "(sent) " : ""}${m.s} | ${m.f} <${m.e.replace(/^.*@/, "")}>`).join("\n")}` }],
      maxTokens: 5000,
      signal: AbortSignal.timeout(120_000),
    } as unknown as CompletionRequest);
    const json = /\{[\s\S]*\}/.exec(r.text)![0];
    writeFileSync(join(DIR, "seeds.json"), JSON.stringify(JSON.parse(json), null, 1));
    console.log(spendReport());
    await t.backend.stop();
  });

  it.runIf(PHASE === "ask")("questions", { timeout: 1_200_000 }, async () => {
    const t = await open("ask");
    for (const { q, expect: wanted } of seeds().questions) {
      t.calls.length = 0;
      const r = await askOnce(t.client, q).catch((e: Error) => ({ status: "error", message: e.message }));
      const material = t.calls.find((c) => c.schema !== "ask_plan")?.prompt ?? "";
      const plan = t.calls.find((c) => c.schema === "ask_plan");
      line("ask.jsonl", { q, wanted, status: r.status, kind: r.turn?.status ?? null, answer: r.turn?.answer ?? null, sources: (r.turn?.sources ?? []).map((s: any) => ({ from: s.fromName || s.fromEmail, subject: s.subject })), checks: r.turn?.checks ?? null, plan: clip(plan?.response, 700), material: clip(material, 9000) });
    }
    console.log(spendReport());
    await t.backend.stop();
  });

  it.runIf(PHASE === "actions")("sentences", { timeout: 1_200_000 }, async () => {
    const t = await open("actions");
    let acknowledged: string | undefined;
    for (const { s: sentence, kind } of seeds().sentences) {
      t.calls.length = 0;
      const said = await askOnce(t.client, sentence).catch((e: Error) => ({ status: "error", message: e.message }));
      const rec: any = { sentence, kind, routed: said.status, answer: said.turn?.answer ?? null };
      if (said.status === "command") {
        try {
        const start: any = await t.client.call("ai.actionStart", { requestId: crypto.randomUUID(), sentence, timezone: "America/Mexico_City" } as never).catch((e: Error) => ({ status: "error", message: e.message }));
        rec.status = start.status;
        rec.alreadyDone = start.done ?? null;
        rec.summary = start.summary ?? start.preview?.plan.summary ?? null;
        if (start.status === "preview") {
          const id = start.preview.previewId;
          let info: any = start.preview;
          for (let i = 0; i < 2000 && info.scanning; i++) {
            await new Promise((r) => setTimeout(r, 50));
            info = await t.client.call("ai.actionToggle", { previewId: id, threadId: 2_000_000_000, included: false });
          }
          if (info.check === "needed") {
            let checked: any = await t.client.call("ai.actionCheck", { previewId: id, requestId: crypto.randomUUID() } as never);
            if (checked.status === "consent") {
              acknowledged = checked.destination;
              checked = await t.client.call("ai.actionCheck", { previewId: id, requestId: crypto.randomUUID(), acknowledge: acknowledged } as never);
            }
            info = checked.preview;
          }
          const page: any = await t.client.call("ai.actionPage", { previewId: id, offset: 0, limit: 60, leftOut: true });
          const off = new Set(page.unticked);
          Object.assign(rec, { plan: info.plan, count: info.count, skipped: info.skipped, leftOut: info.leftOut, unchecked: info.unchecked, check: info.check, keep: info.keep, keepConditions: info.keepConditions, total: page.total, rows: page.items.map((x: any) => ({ from: x.fromName, subject: x.subject, in: !off.has(x.id) })) });
          await t.client.call("ai.actionCancel", { previewId: id });
        }
        } catch (e) {
          rec.status = "error";
          rec.error = (e as Error).message;
        }
      }
      rec.planned = clip(t.calls.find((c) => c.schema === "action_plan")?.response, 900);
      rec.checks = t.calls.filter((c) => c.schema === "action_check").map((c) => ({ asked: clip(c.prompt, 4000), dropped: clip(c.response, 600) }));
      line("actions.jsonl", rec);
    }
    console.log(spendReport());
    await t.backend.stop();
  });

  it.runIf(PHASE === "replies")("replies", { timeout: 1_500_000 }, async () => {
    const t = await open("replies");
    await t.client.call("settings.update", { replies: { enabled: true } });
    // every thread plan 17 calls waiting, as round 1 read: the check isn't Today's rule
    const raw = (t.backend.store as unknown as { db: { all<T>(sql: string, ...a: unknown[]): T[] } }).db;
    const threads = raw.all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND waiting_since IS NOT NULL AND last_date >= ? ORDER BY last_date DESC, id DESC LIMIT ?", t.clock.now - 30 * 86_400_000, Number(process.env.TERNO_RT_N ?? 36));
    for (const { id } of threads) {
      const context = await t.backend.store.writing.threadContext(id, { maxBodies: 2, maxChars: 3000 });
      const newest = context ? [...context.messages].reverse().find((m) => !m.own) : undefined;
      if (!context || !newest) continue;
      t.calls.length = 0;
      const r: any = await t.client.call("ai.prepareReply", { threadId: id, accountId: context.accountId, to: [{ name: newest.fromName, email: newest.fromEmail }], cc: [], timezone: "America/Mexico_City" });
      let row = await t.backend.store.replies.get(id);
      for (let i = 0; i < 1600 && r.status === "started" && (!row || row.sourceStamp !== context.stamp); i++) {
        await new Promise((res) => setTimeout(res, 50));
        row = await t.backend.store.replies.get(id);
      }
      line("replies.jsonl", { subject: context.subject, from: newest.fromName || newest.fromEmail.replace(/^.*@/, "@"), newest: clip(newest.text, 1200), earlier: context.messages.filter((m) => m.own).slice(-1).map((m) => clip(m.text, 500))[0] ?? null, status: r.status, state: row?.state ?? null, reply: row?.body ?? null, checks: row?.checks ?? null, levels: row?.used?.levels ?? null, model: row?.model ?? null });
    }
    console.log(spendReport());
    await t.backend.stop();
  });

  it.runIf(PHASE === "followups")("what was promised", { timeout: 1_500_000 }, async () => {
    const t = await open("followups");
    await t.client.call("settings.update", { followups: { enabled: true } });
    await t.client.call("followups.scan", {});
    t.backend.followups.wake({ network: true } as never);
    for (let i = 0, idle = 0; i < 12_000 && idle < 200; i++) {
      await new Promise((res) => setTimeout(res, 100));
      idle = (await t.backend.store.followups.marks.count()) === 0 ? idle + 1 : 0;
    }
    for (const c of t.calls.filter((x) => x.schema === "sent_mail")) line("followups.jsonl", { sent: clip(c.prompt.slice(c.prompt.indexOf("<own_text>")), 2200), context: clip(c.prompt.slice(0, c.prompt.indexOf("<own_text>")), 1200), read: c.response });
    console.log(`${t.calls.length} reads, ${spendReport()}`);
    await t.backend.stop();
  });

  it.runIf(PHASE === "digest")("the digest, day by day", { timeout: 1_200_000 }, async () => {
    const t = await open("digest");
    await t.client.call("settings.update", { ai: { tasks: { digest: { provider: "anthropic", model: "claude-haiku-5-5" } } } } as never);
    await t.client.call("settings.update", { today: { digest: true, prepareAt: "00:00" } });
    const latest = t.clock.now;
    for (const back of [6, 4, 2, 0]) {
      t.clock.now = latest - back * 86_400_000;
      t.calls.length = 0;
      await t.backend.today.tick();
      await t.backend.today.drain();
      for (const c of t.calls.filter((x) => x.schema === "newsletter_digest")) line("digest.jsonl", { daysBack: back, mail: clip(c.prompt, 26_000), read: c.response });
    }
    console.log(spendReport());
    await t.backend.stop();
  });

  // most of a real mailbox is already read, so a day's digest sees little: the classifier on what's automated, read or not
  it.runIf(PHASE === "digestwide")("the digest's reading, on more mail", { timeout: 600_000 }, async () => {
    const t = await open("digestwide");
    await t.client.call("settings.update", { ai: { tasks: { digest: { provider: "anthropic", model: "claude-haiku-5-5" } } } } as never);
    const rows = t.raw.all<{ id: number; thread_id: number; from_name: string; from_email: string; subject: string; snippet: string }>("SELECT m.id, m.thread_id, m.from_name, m.from_email, m.subject, m.snippet FROM messages m WHERE (m.list_id IS NOT NULL OR m.is_bulk = 1) AND m.is_sent = 0 AND m.is_spam = 0 AND m.is_trash = 0 GROUP BY m.from_email ORDER BY max(m.date) DESC LIMIT 80");
    const ai = await t.backend.aiService.forTask("digest", { foreground: true });
    for (let i = 0; i < rows.length; i += 20) {
      const batch = rows.slice(i, i + 20);
      const items = await Promise.all(batch.map(async (m, n) => {
        const context = await t.backend.store.writing.threadContext(m.thread_id, { maxBodies: 1, maxChars: 2400 });
        return { label: `d${n + 1}`, from: m.from_name || m.from_email, subject: m.subject, text: context?.messages.find((x) => x.id === m.id)?.text ?? m.snippet };
      }));
      const out = await ai.digestNewsletters({ language: "Spanish", items }).catch((e: Error) => {
        const last = t.calls.at(-1);
        line("digest-errors.jsonl", { error: e.message, batch: i, responseChars: last?.response.length ?? 0, ending: clip(last?.response.slice(-400), 400) });
        return [] as Awaited<ReturnType<typeof ai.digestNewsletters>>;
      });
      const byLabel = new Map(out.map((x) => [x.label, x]));
      for (const item of items) line("digest.jsonl", { from: item.from, subject: item.subject, text: clip(item.text, 500), kind: byLabel.get(item.label)?.kind ?? "(forgotten)", line: byLabel.get(item.label)?.line ?? "" });
    }
    console.log(spendReport());
    await t.backend.stop();
  });

  it.runIf(PHASE === "today")("what needs you", { timeout: 300_000 }, async () => {
    const t = await open("today");
    await t.client.call("settings.update", { followups: { enabled: false } });
    const list: any = await t.client.call("today.list", { heldIds: [] });
    for (const section of list.sections) {
      for (const item of section.items) line("today.jsonl", { section: section.kind, why: item.why.kind, from: item.thread.fromName, subject: item.thread.subject, snippet: clip(item.thread.snippet, 200) });
    }
    await new Promise((res) => setTimeout(res, 3000));
    const row: any = await t.client.call("today.digest", {});
    for (const i of row?.items ?? []) line("today.jsonl", { section: "automated", from: i.from, subject: i.subject });
    await t.backend.stop();
  });
});
