/**
 * Offline accuracy test of the categorization engine (plan 02 §9), with AI
 * off and a network guard. The oldest 80% of a mock mailbox is replayed as
 * user categorizations through the real RPC; the newest 20% then arrives
 * through ingestSliced, day by day, and the engine's decisions are scored
 * against the generator's gold labels. Reports: test-results/categorize/.
 */
import dc from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { decide, POLICY } from "@unica/core";
import { createAccount, createCategory, threadFeatures, vetoesFor, type IncomingMessage, sqlDb } from "@unica/db";
import { demoRegistry } from "@unica/mail";
import { generateDataset, MOCK_CATEGORIES, type MockMessage } from "@unica/mock-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { readSettings } from "./settings";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;
const THREADS = 3000;

// ── network guard: any outbound connection fails the suite ──
const connections: string[] = [];
const onUndici = (m: unknown) => connections.push(`undici:${(m as { connectParams: { hostname: string } }).connectParams.hostname}`);
const onSocket = () => connections.push("net:socket");
const realFetch = globalThis.fetch;
beforeAll(() => {
  dc.subscribe("undici:client:beforeConnect", onUndici);
  dc.subscribe("net.client.socket", onSocket);
  globalThis.fetch = (async (input: unknown) => {
    connections.push(`fetch:${String(input)}`);
    throw new Error("network disabled in the categorization eval");
  }) as typeof fetch;
});
afterAll(() => {
  dc.unsubscribe("undici:client:beforeConnect", onUndici);
  dc.unsubscribe("net.client.socket", onSocket);
  globalThis.fetch = realFetch;
  expect(connections).toEqual([]);
});

interface Scenario {
  name: string;
  adversarial: "on" | "cold" | "off";
  coverage: number;
  noise?: number;
  /** at most this many user examples per category */
  fewShot?: number;
  seed?: number;
}

interface Counts {
  auto: number;
  autoCorrect: number;
  suggest: number;
  suggestCorrect: number;
  gold: number;
}

interface Report {
  scenario: Scenario;
  testThreads: number;
  overall: Counts & { autoPrecision: number; autoRecall: number; suggestPrecision: number; reach: number };
  perCategory: Record<string, Counts & { autoPrecision: number; autoRecall: number }>;
  families: Record<string, { threads: number; auto: number; autoWrong: number; suggest: number }>;
  readdedAfterRemoval: number;
  /** why gold labels were not auto-applied: policy gate → count, per category */
  missed: Record<string, Record<string, number>>;
  tookMs: number;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

const threadKey = (m: MockMessage) => m.rfcMessageId.split(".")[0]!;
const goldOf = (tags: readonly string[]) => MOCK_CATEGORIES.filter((c) => c.tags.some((t) => tags.includes(t))).map((c) => c.name);

function groupThreads(messages: MockMessage[]) {
  const by = new Map<string, MockMessage[]>();
  for (const m of messages) by.set(threadKey(m), [...(by.get(threadKey(m)) ?? []), m]);
  return [...by.entries()].map(([key, ms]) => ({ key, messages: ms, rootDate: Math.min(...ms.map((m) => m.date)), tags: ms[0]!.tags, family: ms[0]!.family })).sort((a, b) => a.rootDate - b.rootDate || a.key.localeCompare(b.key));
}

function dataset(s: Scenario) {
  const base = { threads: THREADS, accounts: 4, seed: s.seed ?? Number(process.env.EVAL_SEED ?? 42), now: NOW };
  const regular = groupThreads(generateDataset(base).messages);
  const cutoff = regular[Math.floor(regular.length * 0.8)]!.rootDate;
  const adversarial = s.adversarial === "off" ? undefined : s.adversarial === "cold" ? { coldAfter: cutoff } : true;
  const data = generateDataset({ ...base, adversarial });
  return { data, cutoff, threads: groupThreads(data.messages) };
}

async function run(s: Scenario): Promise<Report> {
  const started = performance.now();
  const { data, cutoff, threads } = dataset(s);
  const dir = mkdtempSync(join(tmpdir(), "unica-eval-"));
  let clock = cutoff;
  const backend = new Backend({ dbPath: join(dir, "eval.db"), version: "eval", cipher: plaintextCipher, providers: demoRegistry, now: () => clock, autoSync: false });
  try {
    const [c, srv] = createMemoryTransportPair();
    backend.connect(srv, { clientId: "eval", origin: "renderer" });
    const client = new RpcClient(c);
    // local signals only
    expect((await readSettings(backend.store)).ai.provider).toBe("none");
    const accountIds = data.accounts.map((a) => createAccount(sqlDb(backend.store), { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color }).id);
    const categoryId = new Map(MOCK_CATEGORIES.map((cat) => [cat.name, createCategory(sqlDb(backend.store), cat.name, cat.color).id]));
    const toIncoming = (m: MockMessage, test: boolean): IncomingMessage => ({
      ...m,
      accountId: accountIds[m.accountIndex]!,
      // new mail lands in the inbox, unread
      ...(test && !m.isSent && !m.isSpam ? { inInbox: true, isRead: false } : {}),
    });

    const train = threads.filter((t) => t.rootDate < cutoff);
    const test = threads.filter((t) => t.rootDate >= cutoff);
    await client.call("settings.update", { autoCategorize: "off" });
    await backend.ingestSliced(train.flatMap((t) => t.messages.map((m) => toIncoming(m, false))));

    // 1. the user files the older mail
    const firstMessage = new Map(threads.map((t) => [t.key, t.messages[0]!.providerMsgId]));
    const threadIdOf = (key: string) => sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", firstMessage.get(key)!)?.thread_id;
    const perCategory = new Map<string, number>();
    for (const t of train) {
      const gold = goldOf(t.tags);
      if (gold.length === 0 || fnv(`cov:${t.key}`) >= s.coverage) continue;
      const id = threadIdOf(t.key);
      if (!id) continue;
      for (const name of gold) {
        let target = name;
        if (s.noise && fnv(`noise:${t.key}:${name}`) < s.noise) {
          const others = MOCK_CATEGORIES.map((c) => c.name).filter((n) => n !== name);
          target = others[Math.floor(fnv(`pick:${t.key}`) * others.length)]!;
        }
        if (s.fewShot !== undefined && (perCategory.get(target) ?? 0) >= s.fewShot) continue;
        perCategory.set(target, (perCategory.get(target) ?? 0) + 1);
        clock = t.rootDate + DAY;
        await client.call("categories.addThreads", { categoryId: categoryId.get(target)!, threadIds: [id] });
      }
    }

    // 2. idle rebuild at the cutoff, then new mail arrives day by day
    clock = cutoff;
    await backend.categorizer.rebuildNow();
    await client.call("settings.update", { autoCategorize: "auto" });
    const testMessages = test.flatMap((t) => t.messages).sort((a, b) => a.date - b.date);
    for (let i = 0; i < testMessages.length; ) {
      const dayEnd = testMessages[i]!.date + DAY;
      const chunk: MockMessage[] = [];
      while (i < testMessages.length && testMessages[i]!.date < dayEnd) chunk.push(testMessages[i++]!);
      clock = chunk[chunk.length - 1]!.date + 60_000;
      await backend.ingestSliced(chunk.map((m) => toIncoming(m, true)));
    }

    // 3. score
    const counts = (): Counts => ({ auto: 0, autoCorrect: 0, suggest: 0, suggestCorrect: 0, gold: 0 });
    const overall = counts();
    const byCat = new Map(MOCK_CATEGORIES.map((cat) => [cat.name, counts()]));
    const families: Report["families"] = {};
    const nameOf = new Map([...categoryId].map(([n, id]) => [id, n]));
    let scored = 0;
    const missed: Report["missed"] = {};
    const model = backend.categorizer.model!;
    const policies = new Map(sqlDb(backend.store).all<{ id: number; auto_apply: number }>("SELECT id, auto_apply FROM categories").map((c) => [c.id, { autoApply: c.auto_apply === 1, kept: 0, reverted: 0 }]));
    for (const t of test) {
      const root = t.messages.find((m) => !m.isSent);
      if (!root || root.isSpam) {
        if (t.family) {
          const f = (families[t.family] ??= { threads: 0, auto: 0, autoWrong: 0, suggest: 0 });
          f.threads++;
        }
        continue;
      }
      const id = threadIdOf(t.key)!;
      scored++;
      const gold = new Set(goldOf(t.tags));
      const decisions = sqlDb(backend.store).all<{ category_id: number; kind: string }>("SELECT category_id, kind FROM cls_decisions WHERE thread_id = ?", id);
      const auto = new Set(decisions.filter((d) => d.kind === "auto").map((d) => nameOf.get(d.category_id)!));
      const suggest = new Set(decisions.filter((d) => d.kind === "suggest").map((d) => nameOf.get(d.category_id)!));
      const set = threadFeatures(sqlDb(backend.store), [id]).get(id);
      if (set) {
        const scores = model.score(set.encoded);
        const ds = decide({
          mode: "auto",
          autoEligible: true,
          scores,
          categories: policies,
          vetoes: vetoesFor(sqlDb(backend.store), id, set.features.sender, scores.map((x) => x.categoryId), clock),
          lookAlike: model.lookAlike(set.encoded),
          senderSupport: model.senderSupport(set.encoded),
        });
        for (const d of ds) {
          const name = nameOf.get(d.categoryId)!;
          if (!gold.has(name) || auto.has(name)) continue;
          const sc = scores.find((x) => x.categoryId === d.categoryId)!;
          const key = `${d.gate} p=${sc.p >= POLICY.autoP ? "hi" : sc.p >= POLICY.suggestP ? "mid" : "lo"} id=${sc.identity ?? "-"}`;
          (missed[name] ??= {})[key] = ((missed[name] ??= {})[key] ?? 0) + 1;
        }
      }
      for (const [name, k] of byCat) {
        const isGold = gold.has(name);
        if (isGold) {
          k.gold++;
          overall.gold++;
        }
        if (auto.has(name)) {
          k.auto++;
          overall.auto++;
          if (isGold) {
            k.autoCorrect++;
            overall.autoCorrect++;
          }
        }
        if (suggest.has(name)) {
          k.suggest++;
          overall.suggest++;
          if (isGold) {
            k.suggestCorrect++;
            overall.suggestCorrect++;
          }
        }
      }
      if (t.family) {
        const f = (families[t.family] ??= { threads: 0, auto: 0, autoWrong: 0, suggest: 0 });
        f.threads++;
        f.auto += auto.size;
        f.autoWrong += [...auto].filter((n) => !gold.has(n)).length;
        f.suggest += suggest.size;
      }
    }

    // 4. the user removes what the engine got wrong; nothing brings it back
    const wrong = sqlDb(backend.store).all<{ thread_id: number; category_id: number }>("SELECT thread_id, category_id FROM cls_decisions WHERE kind = 'auto' LIMIT 20");
    for (const w of wrong) await client.call("categories.removeThreads", { categoryId: w.category_id, threadIds: [w.thread_id] });
    const roots = wrong.map((w) => sqlDb(backend.store).get<{ provider_msg_id: string }>("SELECT provider_msg_id FROM messages WHERE thread_id = ? AND is_sent = 0 ORDER BY date LIMIT 1", w.thread_id)!);
    // the same root arrives again with its body completed: the classifier looks at the thread once more
    sqlDb(backend.store).run(`UPDATE messages SET body_state = 'partial' WHERE provider_msg_id IN (SELECT value FROM json_each(?))`, JSON.stringify(roots.map((r) => r.provider_msg_id)));
    const again = testMessages.filter((m) => roots.some((r) => r.provider_msg_id === m.providerMsgId)).map((m) => toIncoming(m, true));
    await backend.ingestSliced(again);
    const readded = wrong.filter((w) => sqlDb(backend.store).get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", w.thread_id, w.category_id)).length;

    const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
    const report: Report = {
      scenario: s,
      testThreads: scored,
      overall: {
        ...overall,
        autoPrecision: ratio(overall.autoCorrect, overall.auto),
        autoRecall: ratio(overall.autoCorrect, overall.gold),
        suggestPrecision: ratio(overall.suggestCorrect, overall.suggest),
        reach: ratio(overall.autoCorrect + overall.suggestCorrect, overall.gold),
      },
      perCategory: Object.fromEntries([...byCat].map(([n, k]) => [n, { ...k, autoPrecision: ratio(k.autoCorrect, k.auto), autoRecall: ratio(k.autoCorrect, k.gold) }])),
      families,
      readdedAfterRemoval: readded,
      missed,
      tookMs: Math.round(performance.now() - started),
    };
    const out = join(process.cwd(), "test-results", "categorize");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${s.name}.json`), JSON.stringify(report, null, 2));
    const pct = (x: number) => x.toFixed(3);
    console.log(
      `[eval] ${s.name.padEnd(16)} auto P ${pct(report.overall.autoPrecision)} R ${pct(report.overall.autoRecall)} (${overall.auto}) · suggest P ${pct(report.overall.suggestPrecision)} (${overall.suggest}) · auto+suggest R ${pct(report.overall.reach)} · ${report.tookMs} ms\n` +
        Object.entries(report.perCategory)
          .map(([n, k]) => `        ${n.padEnd(11)} auto ${k.autoCorrect}/${k.auto} P ${pct(k.autoPrecision)} R ${pct(k.autoRecall)} · suggest ${k.suggestCorrect}/${k.suggest} · gold ${k.gold}`)
          .join("\n") +
        (process.env.EVAL_DEBUG ? `\n        missed: ${JSON.stringify(missed)}` : ""),
    );
    return report;
  } finally {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectPrecision(r: Report) {
  expect(r.overall.auto, "the engine made auto decisions").toBeGreaterThan(0);
  expect(r.overall.autoPrecision).toBeGreaterThanOrEqual(0.97);
  for (const [name, k] of Object.entries(r.perCategory)) {
    if (k.auto >= 10) expect(k.autoPrecision, `${name} auto precision`).toBeGreaterThanOrEqual(0.95);
  }
  for (const f of ["phish-bank", "uber-promo", "friend-trip"]) expect(r.families[f]?.auto ?? 0, `${f} auto-applies`).toBe(0);
  expect(r.readdedAfterRemoval).toBe(0);
}

describe("categorization accuracy, AI off", () => {
  it("standard (adversarial mailbox, 70% of it filed)", async () => {
    const r = await run({ name: "standard", adversarial: "on", coverage: 0.7 });
    expectPrecision(r);
    expect(r.overall.autoRecall).toBeGreaterThanOrEqual(0.8);
    expect(r.overall.suggestPrecision).toBeGreaterThanOrEqual(0.8);
    expect(r.overall.reach).toBeGreaterThanOrEqual(0.95);
    // a client invoice is filed under both categories
    expect(r.families["client-invoice"]!.auto).toBeGreaterThan(r.families["client-invoice"]!.threads);
    // new senders of receipts reach Facturas through content alone
    expect(r.families["new-receipt"]!.auto).toBeGreaterThan(0);
  });

  it("cold-adversarial (every tricky family appears only in the new mail)", async () => {
    const r = await run({ name: "cold-adversarial", adversarial: "cold", coverage: 0.7 });
    expectPrecision(r);
    expect(r.overall.autoRecall).toBeGreaterThanOrEqual(0.75);
    expect(r.overall.suggestPrecision).toBeGreaterThanOrEqual(0.8);
    // Amazon's sender identity counts against Facturas: suggested, never auto-applied
    expect(r.families["amazon-invoice"]!.auto).toBe(0);
  });

  it("30% coverage", async () => {
    const r = await run({ name: "coverage-30", adversarial: "on", coverage: 0.3 });
    expectPrecision(r);
    expect(r.overall.suggestPrecision).toBeGreaterThanOrEqual(0.8);
  });

  it("5% label noise", async () => {
    const r = await run({ name: "noise-5", adversarial: "on", coverage: 0.7, noise: 0.05 });
    expectPrecision(r);
  });

  it("few-shot (≤ 4 examples per category): nothing is auto-applied", async () => {
    const r = await run({ name: "few-shot", adversarial: "on", coverage: 1, fewShot: 4 });
    expect(r.overall.auto).toBe(0);
    expect(r.readdedAfterRemoval).toBe(0);
  });
});
