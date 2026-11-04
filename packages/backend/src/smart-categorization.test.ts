/**
 * Plan 134 through the backend: which mail reaches the AI, what it's told, what its answer writes. Fakes only: no test
 * here reaches a provider. Filing is proved with a fake `calibrated` model, never with JEV.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, createAi, promptText, type AiTasks, type ClassifyInput, type CompletionRequest } from "@terno/ai";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { addToCategory, createAccount, createCategory, ingestMessages, setSetting, sqlDb, type IncomingMessage } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyLimitError } from "./ai-limiter";
import { Backend, plaintextCipher, type BackendOptions } from "./backend";
import { readSettings } from "./settings";

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let n = 0;
function incoming(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId, providerMsgId: `s${n}`, providerThreadId: null, rfcMessageId: `s${n}@x`, inReplyTo: null, references: [],
    from: { name: `Unknown ${n}`, email: `person${n}@unknown${n}.example` }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [],
    subject: `A question ${n}`, date: NOW - 3_600_000, snippet: "", bodyText: `Something new, number ${n}.`, bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 10,
    ...over,
  };
}

type Answer = { label: string | null; confidence: number };
/** A model that answers as told, through the same interface forTask gives. */
function model(answer: (input: ClassifyInput<string>) => Answer | Promise<Answer>, o: { calibrated?: boolean; contextTokens?: number | null; local?: boolean } = {}) {
  const classify = vi.fn(async (input: ClassifyInput<string>, _signal?: AbortSignal) => {
    const a = await answer(input);
    return input.items.map((i) => ({ id: i.id, ...a }));
  });
  return { providerId: "fake", local: o.local ?? false, model: "m", calibrated: o.calibrated ?? false, contextTokens: o.contextTokens ?? null, endpoint: null, classify } as unknown as AiTasks & { classify: typeof classify };
}

async function mailbox(options: Pick<BackendOptions, "aiFactory" | "log"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-smart-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, ...options });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  await backend.store.ready;
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const db = sqlDb(backend.store);
  const acct = createAccount(db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const invoices = createCategory(db, "Invoices", "amber").id;
  const travel = createCategory(db, "Travel", "cyan").id;
  const placed = ingestMessages(db, Array.from({ length: 6 }, (_, i) => incoming(acct, { from: { name: `Billing ${i}`, email: `billing@vendor${i}.example` }, subject: `Invoice ${i}`, date: NOW - (40 + i) * DAY, inInbox: false })), NOW);
  addToCategory(db, { categoryId: invoices, threadIds: [...placed.touchedThreads], addedBy: "user", now: NOW - 30 * DAY });
  // what nobody files, so the engine has no opinion on an unknown sender
  ingestMessages(db, Array.from({ length: 150 }, (_, i) => incoming(acct, { from: { name: `Friend ${i % 30}`, email: `friend${i % 30}@gmail.example` }, subject: ["Lunch on Saturday", "Trip photos", "Mum's birthday"][i % 3]!, date: NOW - (20 + (i % 100)) * DAY, inInbox: false })), NOW);
  await backend.categorizer.rebuildNow();
  const on = (over: Record<string, unknown> = {}) => setSetting(db, "app", { aiCategorize: true, ai: { provider: "fake" }, ...over });
  const threadOf = (m: IncomingMessage) => db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", m.providerMsgId)!.thread_id;
  const arrive = async (over: Partial<IncomingMessage> = {}, o: { live?: boolean } = {}) => {
    const m = incoming(acct, over);
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, o.live ?? true);
    return { thread: threadOf(m), message: m };
  };
  const decisions = (thread: number) => db.all<{ category_id: number; kind: string; p: number; explain_json: string }>("SELECT category_id, kind, p, explain_json FROM cls_decisions WHERE thread_id = ?", thread);
  const filed = (thread: number) => db.all<{ category_id: number; added_by: string }>("SELECT category_id, added_by FROM thread_categories WHERE thread_id = ?", thread);
  const marks = async () => (await backend.store.newMail.page("category", null, 100)).length;
  return { backend, client, db, acct, invoices, travel, on, arrive, decisions, filed, marks };
}

describe("which mail reaches the AI (plan 134 §1)", () => {
  it("an unknown sender does, and only as live mail", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.invoices}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(ai.classify).toHaveBeenCalledTimes(1);
    expect(t.decisions(thread)).toMatchObject([{ category_id: t.invoices, kind: "suggest" }]);
    expect(await t.marks()).toBe(0);
    // a first sync, a backfill, an import, the demo: none of them live
    await t.arrive({}, { live: false });
    await t.backend.aiAssist.drain();
    expect(ai.classify).toHaveBeenCalledTimes(1);
  });

  it("nothing is marked while the switch is off, and turning it on doesn't reach back", async () => {
    const t = await mailbox();
    const ai = model(() => ({ label: `c${t.invoices}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    const { thread } = await t.arrive();
    expect(await t.marks()).toBe(0);
    await t.client.call("settings.update", { aiCategorize: true, ai: { provider: "fake" } });
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    expect(t.decisions(thread)).toEqual([]);
  });

  it.each([
    ["spam", { isSpam: true, inInbox: false }],
    ["trash", { isTrash: true, inInbox: false }],
    ["a draft", { isDraft: true }],
    ["archived", { inInbox: false }],
    ["old", { date: NOW - 5 * DAY }],
    ["from me", { from: { name: "Me", email: "me@example.com" } }],
  ] as const)("%s doesn't", async (_name, over) => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.invoices}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    await t.arrive(over);
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    expect(await t.marks()).toBe(0);
  });

  it("what a filter placed isn't sent", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.invoices}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    const m = incoming(t.acct);
    await t.backend.store.filters.save({ name: "To invoices", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "from", op: "equals", value: m.from.email, negate: false }], actions: [{ type: "addCategory", categoryId: t.invoices }] } } as never, NOW);
    await t.backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    // settled: its mark is gone too
    expect(await t.marks()).toBe(0);
  });

  it("the mark waits for a model: the engine goes first, and a ready model wakes it", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.travel}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    const built = t.backend.categorizer.model;
    Reflect.set(t.backend.categorizer, "current", null);
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    expect(await t.marks()).toBe(1);
    Reflect.set(t.backend.categorizer, "current", built);
    t.backend.aiAssist.wake();
    await t.backend.aiAssist.drain();
    expect(t.decisions(thread)).toMatchObject([{ category_id: t.travel }]);
    expect(await t.marks()).toBe(0);
  });

  it("the mark waits for a late body, whose arrival isn't live mail", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.travel}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    const { thread, message } = await t.arrive({ bodyText: null, bodyState: "none" });
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    expect(await t.marks()).toBe(1);
    await t.backend.ingestSliced([{ ...message, bodyState: "full", bodyText: "Your flight tomorrow." }]);
    await t.backend.aiAssist.drain();
    expect(ai.classify).toHaveBeenCalledTimes(1);
    expect(ai.classify.mock.calls[0]![0].items[0]!.text).toContain("Your flight tomorrow.");
    expect(t.decisions(thread)).toHaveLength(1);
  });

  it("marks survive a quit: a new start picks up what's marked", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.travel}`, confidence: 0.9 }));
    t.backend.ai = async () => {
      throw new AiError("down", "unavailable");
    };
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(await t.marks()).toBe(1);
    t.backend.ai = async () => ai;
    // what a restart does
    t.backend.aiAssist.wake({ network: true });
    await t.backend.aiAssist.drain();
    expect(t.decisions(thread)).toHaveLength(1);
    expect(await t.marks()).toBe(0);
  });

  it("turning it off forgets what's marked: it can't go out the next time it's on", async () => {
    const t = await mailbox();
    t.on();
    t.backend.ai = async () => {
      throw new AiError("down", "not_configured");
    };
    await t.arrive();
    expect(await t.marks()).toBe(1);
    await t.client.call("settings.update", { aiCategorize: false });
    await vi.waitFor(async () => expect(await t.marks()).toBe(0));
  });
});

describe("what it's told (plan 134 §2)", () => {
  async function captured(contextTokens: number | null = null) {
    const requests: CompletionRequest[] = [];
    const t = await mailbox({
      aiFactory: (config) =>
        createAi({ ...config, capabilities: { output: "json_schema", contextTokens, embeddings: false, probedAt: null } }, {
          transport: {
            async complete(req) {
              requests.push(req);
              const items = JSON.parse(promptText(req.messages[0]!.content).split("\nItems: ")[1]!) as { id: string }[];
              return { stop: "end", text: JSON.stringify({ results: items.map(({ id }) => ({ id, label: `c${1}`, confidence: 0.9 })) }) };
            },
          },
        }),
    });
    t.on();
    return { t, requests };
  }

  it("every category under a stable label; samples as data in the user turn, never the system prompt, and no addresses", async () => {
    const { t, requests } = await captured();
    const { thread } = await t.arrive({ from: { name: "Dana", email: "dana@secret.example" }, subject: "Hello there" });
    await t.backend.aiAssist.drain();
    const system = promptText(requests[0]!.system);
    const user = promptText(requests[0]!.messages[0]!.content);
    expect(user).toContain(`"c${t.invoices}"`);
    expect(user).toContain(`"c${t.travel}"`);
    expect(user).toContain("Invoice 5");
    expect(user).toContain("vendor5.example");
    expect(user).not.toContain("billing@vendor5.example");
    expect(system).not.toContain("Invoice 5");
    expect(system).not.toContain("Hello there");
    // the mail's own sender and subject are neutral, not Spanish-only
    expect(user).toContain("From: Dana <dana@secret.example>");
    expect(user).toContain("Subject: Hello there");
    expect(t.decisions(thread)).toMatchObject([{ category_id: 1, kind: "suggest", p: 0.9 }]);
    expect(JSON.parse(t.decisions(thread)[0]!.explain_json)[0]).toEqual({ k: "reason.aiLocal", p: { category: "Invoices" } });
  });

  it("a label it wasn't offered fails validation and writes nothing", async () => {
    const t = await mailbox({
      aiFactory: (config) =>
        createAi({ ...config, capabilities: { output: "json_schema", contextTokens: null, embeddings: false, probedAt: null } }, {
          transport: {
            async complete(req) {
              const items = JSON.parse(promptText(req.messages[0]!.content).split("\nItems: ")[1]!) as { id: string }[];
              return { stop: "end", text: JSON.stringify({ results: items.map(({ id }) => ({ id, label: "Invoices", confidence: 0.99 })) }) };
            },
          },
        }),
    });
    t.on();
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.decisions(thread)).toEqual([]);
    expect(t.filed(thread)).toEqual([]);
  });

  it("a small context window loses samples before it loses a category", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: null, confidence: 0 }), { contextTokens: 1020 });
    t.backend.ai = async () => ai;
    await t.arrive();
    await t.backend.aiAssist.drain();
    const input = ai.classify.mock.calls[0]![0];
    expect(input.labels).toEqual(expect.arrayContaining([`c${t.invoices}`, `c${t.travel}`]));
    expect(input.evidence![`c${t.invoices}`]!.samples).toEqual([]);
  });

  it("a category it vetoes for this sender isn't offered", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: null, confidence: 0 }));
    t.backend.ai = async () => ai;
    const from = { name: "Pushy", email: "pushy@vendor.example" };
    for (let i = 0; i < 2; i++) {
      const { thread } = await t.arrive({ from }, { live: false });
      await t.backend.store.categories.add({ categoryId: t.invoices, threadIds: [thread], addedBy: "auto", now: NOW });
      await t.backend.store.categories.remove({ categoryId: t.invoices, threadIds: [thread], reason: "user", now: NOW });
    }
    await t.arrive({ from });
    await t.backend.aiAssist.drain();
    expect(ai.classify.mock.calls[0]![0].labels).toEqual([`c${t.travel}`]);
  });

  it("reads the evidence once, until a category or an example changes", async () => {
    const t = await mailbox();
    t.on();
    t.backend.ai = async () => model(() => ({ label: null, confidence: 0 }));
    const read = vi.spyOn(t.backend.store.categorize, "categoryEvidence");
    await t.arrive();
    await t.backend.aiAssist.drain();
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(read).toHaveBeenCalledTimes(1);
    const { thread } = await t.arrive({}, { live: false });
    await t.client.call("categories.addThreads", { categoryId: t.travel, threadIds: [thread] });
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(read).toHaveBeenCalledTimes(2);
    await t.backend.store.categories.update(t.travel, { name: "Trips" });
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("its limits and its failures (plan 134 §3)", () => {
  it("a provider switch mid-call sends nothing further and writes nothing", async () => {
    const t = await mailbox();
    t.on();
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const first = model(async () => {
      await answered;
      return { label: `c${t.invoices}`, confidence: 0.9 };
    });
    t.backend.ai = async () => first;
    const a = await t.arrive();
    const b = await t.arrive();
    const running = t.backend.aiAssist.drain();
    await vi.waitFor(() => expect(first.classify).toHaveBeenCalledTimes(1));
    const second = model(() => ({ label: null, confidence: 0 }));
    t.backend.ai = async () => second;
    await t.client.call("settings.update", { ai: { provider: "fake", model: "other" } });
    expect(first.classify.mock.calls[0]![1]!.aborted).toBe(true);
    release();
    await running;
    // what's marked goes to the provider now chosen
    await vi.waitFor(() => expect(second.classify).toHaveBeenCalledTimes(2));
    expect(first.classify).toHaveBeenCalledTimes(1);
    expect(t.decisions(a.thread)).toEqual([]);
    expect(t.decisions(b.thread)).toEqual([]);
  });

  it.each(["unavailable", "rate_limited", "timeout"] as const)("%s: one attempt, marks kept, a minute's wait; no other provider is asked", async (kind) => {
    const t = await mailbox();
    t.on();
    let attempts = 0;
    t.backend.ai = async () => model(() => {
      attempts++;
      throw new AiError("no", kind);
    });
    await t.arrive();
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(attempts).toBe(1);
    expect(await t.marks()).toBe(2);
    // new mail doesn't ask it again yet
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(attempts).toBe(1);
    t.backend.aiAssist.wake({ network: true });
    await t.backend.aiAssist.drain();
    expect(attempts).toBe(2);
  });

  it("the day's cap stops it until the next day, keeping the marks", async () => {
    let now = NOW;
    const t = await mailbox();
    Reflect.set(t.backend, "now", () => now);
    t.on();
    let attempts = 0;
    let limited = true;
    const { thread } = await (async () => {
      t.backend.ai = async () => model(() => {
        attempts++;
        if (limited) throw new DailyLimitError();
        return { label: `c${t.invoices}`, confidence: 0.9 };
      });
      return t.arrive();
    })();
    await t.backend.aiAssist.drain();
    expect(attempts).toBe(1);
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(attempts).toBe(1);
    expect(await t.marks()).toBe(2);
    limited = false;
    now = NOW + DAY;
    t.backend.aiAssist.wake();
    await t.backend.aiAssist.drain();
    expect(t.decisions(thread)).toHaveLength(1);
  });

  it("a bad answer is that thread's alone: its mark goes and the rest carry on", async () => {
    const t = await mailbox();
    t.on();
    let calls = 0;
    t.backend.ai = async () => model(() => {
      if (++calls === 1) throw new AiError("nonsense", "invalid_output");
      return { label: `c${t.invoices}`, confidence: 0.9 };
    });
    const a = await t.arrive();
    const b = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.decisions(a.thread)).toEqual([]);
    expect(t.decisions(b.thread)).toHaveLength(1);
    expect(await t.marks()).toBe(0);
  });
});

describe("the one-time reset (plan 134 §3)", () => {
  it("a switch that was on goes off once, with the line; mail sent in between: none; on again stays on", async () => {
    const t = await mailbox();
    t.on();
    const ai = model(() => ({ label: `c${t.invoices}`, confidence: 0.9 }));
    t.backend.ai = async () => ai;
    await t.backend.aiAssist.start();
    const after = await readSettings(t.backend.store);
    expect(after.aiCategorize).toBe(false);
    expect(after.aiCategorizeWidened).toBe(true);
    await t.arrive();
    await t.backend.aiAssist.drain();
    expect(ai.classify).not.toHaveBeenCalled();
    expect(await t.marks()).toBe(0);
    const seen = await t.client.call("settings.update", { aiCategorizeWidened: false });
    expect(seen.aiCategorizeWidened).toBe(false);
    await t.client.call("settings.update", { aiCategorize: true });
    await t.backend.aiAssist.start();
    expect((await readSettings(t.backend.store)).aiCategorize).toBe(true);
    expect((await readSettings(t.backend.store)).aiCategorizeWidened).toBe(false);
  });

  it("someone who never had it on sees nothing", async () => {
    const t = await mailbox();
    await t.backend.aiAssist.start();
    const after = await readSettings(t.backend.store);
    expect(after.aiCategorize).toBe(false);
    expect(after.aiCategorizeWidened).toBe(false);
  });
});

describe("filing (plan 134 part B)", () => {
  async function filing(answer: (t: Awaited<ReturnType<typeof mailbox>>) => Answer | Promise<Answer>, o: { calibrated?: boolean; settings?: Record<string, unknown> } = {}) {
    const t = await mailbox();
    t.on(o.settings);
    const ai = model(() => answer(t), { calibrated: o.calibrated ?? true });
    t.backend.ai = async () => ai;
    return { t, ai };
  }

  it("files above the bar, as the engine does, and never trains", async () => {
    const { t } = await filing((m) => ({ label: `c${m.invoices}`, confidence: 0.99 }));
    const positives = t.backend.categorizer.model!.positives(t.invoices);
    const announced = vi.spyOn(t.backend, "announceFiled");
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([{ category_id: t.invoices, added_by: "auto" }]);
    expect(t.decisions(thread)).toMatchObject([{ category_id: t.invoices, kind: "auto", p: 0.99 }]);
    expect(JSON.parse(t.decisions(thread)[0]!.explain_json)[0]).toMatchObject({ k: "reason.aiFiled", p: { category: "Invoices" } });
    expect(announced).toHaveBeenCalledWith(t.invoices, thread);
    expect(t.backend.categorizer.model!.positives(t.invoices)).toBe(positives);
  });

  it("suggests in the band below, with the AI's own confidence", async () => {
    const { t } = await filing((m) => ({ label: `c${m.invoices}`, confidence: 0.9 }));
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([]);
    expect(t.decisions(thread)).toMatchObject([{ kind: "suggest", p: 0.9 }]);
  });

  it("nothing at null, or below 0.7", async () => {
    for (const a of [{ label: null, confidence: 0.99 }, { label: "c1", confidence: 0.5 }]) {
      const { t } = await filing(() => a);
      const { thread } = await t.arrive();
      await t.backend.aiAssist.drain();
      expect(t.filed(thread)).toEqual([]);
      expect(t.decisions(thread)).toEqual([]);
    }
  });

  it("a provider that isn't calibrated never files, whatever it reports", async () => {
    const { t } = await filing((m) => ({ label: `c${m.invoices}`, confidence: 1 }), { calibrated: false });
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([]);
    expect(t.decisions(thread)).toMatchObject([{ kind: "suggest", p: 1 }]);
  });

  it("where the user lets the engine only suggest, a calibrated model only suggests", async () => {
    const { t } = await filing((m) => ({ label: `c${m.invoices}`, confidence: 0.99 }), { settings: { autoCategorize: "suggest" } });
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([]);
    expect(t.decisions(thread)).toMatchObject([{ kind: "suggest" }]);
  });

  it("a category with no examples can't receive a filing, however confident", async () => {
    const { t } = await filing((m) => ({ label: `c${m.travel}`, confidence: 1 }));
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([]);
    expect(t.decisions(thread)).toMatchObject([{ category_id: t.travel, kind: "suggest" }]);
  });

  it.each(["hidden", "forwarding", "auto-apply off"] as const)("a category that became %s while the model answered gets a suggestion, and no forward", async (change) => {
    const { t } = await filing(async (m) => {
      if (change === "hidden") await m.backend.store.categories.update(m.invoices, { showInInbox: false });
      if (change === "auto-apply off") await m.backend.store.categories.update(m.invoices, { autoApply: false });
      if (change === "forwarding") await m.client.call("categories.setForward", { categoryId: m.invoices, forward: { addresses: [{ name: "", email: "elsewhere@example.com" }], enabled: true } });
      return { label: `c${m.invoices}`, confidence: 0.99 };
    });
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([]);
    expect(t.decisions(thread)).toMatchObject([{ kind: "suggest" }]);
    expect(t.db.get("SELECT count(*) AS n FROM forwards")).toEqual({ n: 0 });
  });

  it("the user placing it while the model answered wins", async () => {
    const { t } = await filing(async (m) => {
      const [row] = m.db.all<{ thread_id: number }>("SELECT thread_id FROM ai_new_mail");
      await m.client.call("categories.addThreads", { categoryId: m.travel, threadIds: [row!.thread_id] });
      return { label: `c${m.invoices}`, confidence: 0.99 };
    });
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    expect(t.filed(thread)).toEqual([expect.objectContaining({ category_id: t.travel, added_by: "user" })]);
    expect(t.decisions(thread)).toEqual([]);
  });

  it("removing what it filed is a revert, through the RPC the chip uses", async () => {
    const { t } = await filing((m) => ({ label: `c${m.invoices}`, confidence: 0.99 }));
    const positives = t.backend.categorizer.model!.positives(t.invoices);
    const { thread } = await t.arrive();
    await t.backend.aiAssist.drain();
    await t.client.call("categories.removeThreads", { categoryId: t.invoices, threadIds: [thread] });
    expect(t.db.get("SELECT outcome FROM cls_decisions WHERE thread_id = ?", thread)).toEqual({ outcome: "reverted" });
    expect(t.backend.categorizer.model!.positives(t.invoices)).toBe(positives);
  });
});

describe("a JEV key (plan 134)", () => {
  it("chooses where categorization runs, calibrated; removing it goes back to the provider row; the key never comes back", async () => {
    const t = await mailbox();
    t.on();
    const secret = "jev-synthetic-key-1234";
    const saved = await t.client.call("ai.setKey", { provider: "jev", value: secret });
    expect(saved.ai.keys.jev).toEqual({ hasKey: true, keyHint: "1234" });
    expect(JSON.stringify(saved)).not.toContain(secret);
    const ai = await t.backend.ai();
    expect(ai).toMatchObject({ providerId: "jev", calibrated: true, local: false });
    const removed = await t.client.call("ai.setKey", { provider: "jev", value: "" });
    expect(removed.ai.keys.jev?.hasKey ?? false).toBe(false);
    expect(await t.backend.ai()).toMatchObject({ providerId: "fake", calibrated: false });
  });

  it("a key removed mid-queue stops at the next item: nothing already asked lands, nothing more goes to it", async () => {
    const t = await mailbox();
    t.on();
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const first = model(async () => {
      await answered;
      return { label: `c${t.invoices}`, confidence: 0.99 };
    }, { calibrated: true });
    t.backend.ai = async () => first;
    const a = await t.arrive();
    await t.arrive();
    const running = t.backend.aiAssist.drain();
    await vi.waitFor(() => expect(first.classify).toHaveBeenCalledTimes(1));
    const none = model(() => ({ label: null, confidence: 0 }));
    t.backend.ai = async () => none;
    await t.client.call("ai.setKey", { provider: "jev", value: "" });
    release();
    await running;
    expect(first.classify).toHaveBeenCalledTimes(1);
    expect(t.filed(a.thread)).toEqual([]);
    expect(t.decisions(a.thread)).toEqual([]);
  });
});
