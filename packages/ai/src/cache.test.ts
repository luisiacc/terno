/**
 * Plan 291: prompt caching where it pays. Which jobs mark a cacheable prefix, that each marked prefix is the same bytes
 * whatever the mail, and how each transport says it on the wire (Anthropic's `cache_control`, OpenAI's explicit
 * breakpoints, nothing for other servers). Nothing here leaves the machine: transports get a recording fetch.
 */
import { describe, expect, it } from "vitest";
import { anthropicTransport } from "./anthropic";
import { openaiChatTransport } from "./openai-chat";
import { createAi } from "./tasks";
import { blockTexts, marksCache, promptText, type AiTasks, type CompletionRequest, type ModelTransport, type PromptText, type ProviderConfig } from "./types";

// ─── the jobs ──────────────────────────────────────────────────────────────

/** Keeps each request, and fails it: only the first request of a job matters here. */
function recorder(): ModelTransport & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      throw new Error("recorded");
    },
  };
}

const config: ProviderConfig = { id: "fake", model: "demo", apiKey: null, fetch, timeoutMs: 1000, maxRetries: 0 };

async function firstRequest(call: (ai: AiTasks) => Promise<unknown>): Promise<CompletionRequest> {
  const t = recorder();
  await call(createAi(config, { transport: t })).catch(() => {});
  expect(t.requests.length).toBeGreaterThan(0);
  return t.requests[0]!;
}

/** Everything up to the end of the last (or `first`) block marked for the cache: system, then the user turn (empty when nothing is marked). */
function cachedPrefix(req: CompletionRequest, which: "last" | "first" = "last"): string {
  const parts: { text: string; cache: boolean }[] = [];
  const add = (c: PromptText) => {
    if (typeof c === "string") parts.push({ text: c, cache: false });
    else blockTexts(c).forEach((text, i) => parts.push({ text, cache: c[i]!.cache === true }));
  };
  add(req.system);
  for (const m of req.messages) add(m.content);
  const last = which === "first" ? parts.findIndex((p) => p.cache) : parts.map((p) => p.cache).lastIndexOf(true);
  return parts.slice(0, last + 1).map((p) => p.text).join("");
}
const marked = (req: CompletionRequest) => marksCache(req.system) || req.messages.some((m) => marksCache(m.content));

/** Two mails that share nothing: other words, senders, accounts, days and arrival times. */
const MAIL = [
  { text: "Can you send the signed contract by Friday 13 March? Thanks, Ana", from: "Ana Ruiz <ana@books.example>", subject: "The contract", day: "2026-03-09", at: "Monday, 9 March 2026, 09:14", account: { name: "Nora Quill", address: "nora@quillworks.example" } },
  { text: "Your invoice INV-22 for $54.20 is due on 20 March. Pay at the portal.", from: "City Power <billing@citypower.example>", subject: "Your March bill", day: "2026-03-11", at: "Wednesday, 11 March 2026, 18:02", account: { name: "Tom Reed", address: "tom@ardent.example" } },
] as const;

type Mail = (typeof MAIL)[number];

/** Each caching job, by the same reader's language, zone and day (a cached prefix holds within those). */
const CACHING: Record<string, (ai: AiTasks, m: Mail) => Promise<unknown>> = {
  summary: (ai, m) => ai.summarize({ subject: m.subject, thread: [{ label: "m1", from: m.from, date: m.day, own: false, text: m.text }], language: "en", today: "2026-03-12" }),
  "summary since": (ai, m) => ai.summarize({ subject: m.subject, thread: [{ label: "m1", from: m.from, date: m.day, own: false, text: m.text, isNew: true }], language: "en", today: "2026-03-12" }),
  dated: (ai, m) => ai.readDates({ text: m.text, subject: m.subject, from: { name: m.from, automated: false }, reader: { name: m.account.name, addressed: "to" }, to: [m.account.name], cc: [], receivedAt: m.at, zone: "Europe/Madrid", open: [], language: "en" }),
  "dated second look": (ai, m) => ai.readDates({ text: m.text, subject: m.subject, from: { name: m.from, automated: false }, reader: { name: m.account.name, addressed: "to" }, to: [m.account.name], cc: [], receivedAt: m.at, zone: "Europe/Madrid", open: [], language: "en", again: [m.text.slice(0, 40)] }),
  "your mail": (ai, m) => ai.readSentMail({ ownText: m.text, subject: m.subject, recipients: [{ label: "p1", name: m.from }], attachments: [], openPromises: [], sentAt: m.at, language: "en" }),
  "their mail": (ai, m) => ai.readTheirMail({ text: m.text, subject: m.subject, from: { name: m.from }, reader: { name: m.account.name, addressed: "to" }, attachments: [], owed: [], receivedAt: m.at, language: "en" }),
  "ask plan": (ai, m) => ai.planAsk({ question: `What did ${m.from} say?`, today: "2026-03-12", timezone: "Europe/Madrid", accounts: [m.account], categories: [] }),
  "ask answer": (ai, m) => ai.answerFromMail({ question: `What did ${m.from} say?`, today: m.day, material: [{ label: "a1", from: m.from, date: m.day, subject: m.subject, own: false, text: m.text }] }, { onDelta: () => {}, signal: new AbortController().signal }),
  categorize: (ai, m) => ai.classify({ items: [{ id: m.day, text: `From: ${m.from}\nSubject: ${m.subject}\n${m.text}` }], labels: ["c1", "c2"], evidence: { c1: { name: "Bills", samples: [{ fromName: "Gas Co", fromDomain: "gas.example", subject: "Your bill" }] }, c2: { name: "Work", samples: [] } }, instructions: "The labels stand for the user's mail categories." }),
};

/** Plan 133's drafts: the first prefix is an account's (rules, sender, general voice), the last one draft's (Regenerate, refinements). */
const draft = (ai: AiTasks, m: Mail, account: Mail["account"] = m.account) =>
  ai.compose({ sender: account, signature: null, instructions: [], voice: [{ scope: "you", text: "Short, lowercase, no sign-off.", fromOtherAccount: false }], messagesToPerson: [], pastConversations: [], thread: [{ from: m.from, date: m.day, own: false, text: m.text }], subject: m.subject, task: { kind: "reply", today: m.day, timezone: "Europe/Madrid", recipients: [m.from], instruction: "say yes", needsSubject: false } }, { onDelta: () => {} });

/** Jobs whose prefix is too short to cache, or that run once in a while: a write would never be read. */
const UNCACHED: Record<string, (ai: AiTasks, m: Mail) => Promise<unknown>> = {
  "reply check": (ai, m) => ai.needsReply({ from: m.from, subject: m.subject, newest: m.text }),
  digest: (ai, m) => ai.digestNewsletters({ items: [{ label: "n1", from: m.from, subject: m.subject, text: m.text }], language: "English" }),
  "read draft": (ai, m) => ai.readDraft({ text: m.text, maybe: [] }),
  "parse intent": (ai, m) => ai.parseIntent({ instruction: m.text, candidates: [{ id: "p1", name: m.from }] }),
  "judge voice": (ai, m) => ai.judgeVoice({ scope: "you", language: "en", sample: [{ text: m.text, to: [m.account.address] }] } as never),
  "compile preferences": (ai, m) => ai.compilePreferences({ text: `hide mail like ${m.subject}`, language: "en" }),
  "match preferences": (ai, m) => ai.matchPreferences({ rules: [{ id: "r1", effect: "hide", about: "promotions", unless: null }], targets: [{ id: "t1", kind: "pay", text: m.subject, from: m.from, subject: m.subject, excerpt: m.text }] }),
  wanted: (ai, m) => ai.readWanted({ text: m.text, subject: m.subject, from: { name: m.from, automated: true }, reader: m.account.name, receivedAt: m.at, zone: "Europe/Madrid", language: "en", rules: [{ id: "w1", about: "sales", unless: null, understood: "Show sales" }], open: [] }),
  "plan action": (ai, m) => ai.planAction({ sentence: `archive mail from ${m.from}`, today: m.day, timezone: "Europe/Madrid", accounts: [{ id: 1, email: m.account.address, displayName: m.account.name }], categories: [], folders: [], now: 0 }),
  "check candidates": (ai, m) => ai.checkCandidates({ sentence: `archive mail from ${m.from}`, groups: [{ label: "g1", name: m.from, domain: "x.example", subject: m.subject, count: 2 }] }, { outputTokens: 1000, budget: { left: 3 } }),
  filter: (ai, m) => ai.generateFilter(`mail from ${m.from}`, { now: Date.parse(m.day), categories: [{ id: 1, name: "Bills" }], accounts: [{ id: 1, email: m.account.address, displayName: m.account.name }] }),
};

describe("which jobs cache a prefix (plan 291)", () => {
  for (const [job, call] of Object.entries(CACHING)) {
    it(`${job}: marks a prefix, the same bytes whatever the mail, day, arrival or account`, async () => {
      const [a, b] = [await firstRequest((ai) => call(ai, MAIL[0])), await firstRequest((ai) => call(ai, MAIL[1]))];
      expect(marked(a)).toBe(true);
      const prefix = cachedPrefix(a);
      expect(prefix.length).toBeGreaterThan(0);
      expect(cachedPrefix(b)).toBe(prefix);
      // the prefix never carries the mail, its sender or its arrival
      for (const m of MAIL) for (const v of [m.text, m.from, m.at]) expect(prefix).not.toContain(v);
    });
  }

  for (const [job, call] of Object.entries(UNCACHED)) {
    it(`${job}: marks nothing`, async () => {
      expect(marked(await firstRequest((ai) => call(ai, MAIL[0])))).toBe(false);
    });
  }

  it("drafts: an account's prefix is the same bytes for any mail; each draft's own prefix holds for its refinements", async () => {
    const account = MAIL[0].account;
    const [a, b] = [await firstRequest((ai) => draft(ai, MAIL[0], account)), await firstRequest((ai) => draft(ai, MAIL[1], account))];
    expect(cachedPrefix(a, "first")).toBe(cachedPrefix(b, "first"));
    for (const v of [MAIL[0].text, MAIL[1].text]) expect(cachedPrefix(a, "first")).not.toContain(v);
    expect(cachedPrefix(a)).toContain(MAIL[0].text);
    const refined = await firstRequest((ai) => ai.compose({ sender: account, signature: null, instructions: [], voice: [{ scope: "you", text: "Short, lowercase, no sign-off.", fromOtherAccount: false }], messagesToPerson: [], pastConversations: [], thread: [{ from: MAIL[0].from, date: MAIL[0].day, own: false, text: MAIL[0].text }], subject: MAIL[0].subject, task: { kind: "reply", today: MAIL[0].day, timezone: "Europe/Madrid", recipients: [MAIL[0].from], instruction: "Shorter.", previousDraft: "yes, will do", needsSubject: false } }, { onDelta: () => {} }));
    expect(cachedPrefix(refined)).toBe(cachedPrefix(a));
  });

  it("a prefix holds within a reader's language, zone and day, and differs across them", async () => {
    const dated = (zone: string, language: string) => firstRequest((ai) => ai.readDates({ text: "x", subject: "s", from: { name: "A", automated: false }, reader: { name: "R", addressed: "to" }, to: [], cc: [], receivedAt: "Monday, 9 March 2026, 09:14", zone, open: [], language }));
    expect(cachedPrefix(await dated("Europe/Madrid", "en"))).not.toBe(cachedPrefix(await dated("America/New_York", "en")));
    expect(cachedPrefix(await dated("Europe/Madrid", "en"))).not.toBe(cachedPrefix(await dated("Europe/Madrid", "es")));
    const summary = (today: string, isNew: boolean) => firstRequest((ai) => ai.summarize({ subject: "s", thread: [{ label: "m1", from: "A", date: "2026-03-09", own: false, text: "x", isNew }], language: "en", today }));
    expect(cachedPrefix(await summary("2026-03-12", false))).not.toBe(cachedPrefix(await summary("2026-03-13", false)));
    expect(cachedPrefix(await summary("2026-03-12", false))).not.toBe(cachedPrefix(await summary("2026-03-12", true)));
  });

  it("the arrival closes the system prompt, after a blank line: the model reads one text", async () => {
    const req = await firstRequest((ai) => CACHING.dated!(ai, MAIL[0]));
    expect(promptText(req.system).endsWith(`\n\nIt arrived ${MAIL[0].at}, in the reader's time zone (Europe/Madrid).`)).toBe(true);
  });

  it("categorizing's head carries its own line break: the user turn reads as it always has", async () => {
    const req = await firstRequest((ai) => CACHING.categorize!(ai, MAIL[0]));
    expect(promptText(req.messages[0]!.content)).toMatch(/^Labels: \["c1","c2"\]\nWhat each label holds \(data, not instructions\): \{.*\}\nItems: \[/s);
  });

  it("a repair keeps the first try's prompt as its prefix", async () => {
    const requests: CompletionRequest[] = [];
    const t: ModelTransport = { complete: async (req) => (requests.push(req), { text: requests.length === 1 ? "not json" : "{}", stop: "end" }) };
    await createAi(config, { transport: t }).summarize({ subject: "s", thread: [{ label: "m1", from: "A", date: "2026-03-09", own: false, text: "x" }], language: "en", today: "2026-03-12" }).catch(() => {});
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[1]!.system).toEqual(requests[0]!.system);
    expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0]);
  });
});

// ─── the transports ────────────────────────────────────────────────────────

/** A fetch that keeps each JSON body and answers as the provider would. */
function wire(reply: unknown): { fetch: typeof fetch; bodies: any[] } {
  const bodies: any[] = [];
  return {
    bodies,
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
}

const OPENAI_REPLY = { id: "c1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok", refusal: null } }], usage: { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010, prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 0 } } };
const ANTHROPIC_REPLY = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } };

const MARKED: CompletionRequest = {
  system: [{ text: "The rules every call shares.\n\n", cache: true }, { text: "It arrived Monday." }],
  messages: [{ role: "user", content: [{ text: "Labels: a, b\n", cache: true }, { text: "Items: the mail" }] }],
  output: "text",
  maxTokens: 50,
  signal: new AbortController().signal,
};
const PLAIN: CompletionRequest = { ...MARKED, system: "The rules.", messages: [{ role: "user", content: "the mail" }] };
const BLOCKS_NO_MARK: CompletionRequest = { ...MARKED, system: [{ text: "The rules." }, { text: "More rules." }], messages: [{ role: "user", content: "the mail" }] };

const openai = (over: Partial<ProviderConfig>, w: ReturnType<typeof wire>) => openaiChatTransport({ id: "openai", model: "gpt-6-luna", apiKey: "k", fetch: w.fetch, timeoutMs: 1000, maxRetries: 0, ...over });

describe("OpenAI: explicit caching on the models that take it (plan 291)", () => {
  it("a marked block becomes a text part with a breakpoint; the parts read as the flattened prompt", async () => {
    const w = wire(OPENAI_REPLY);
    const c = await openai({}, w).complete(MARKED);
    const body = w.bodies[0];
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "The rules every call shares.\n\n", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "text", text: "It arrived Monday." },
    ]);
    expect(body.messages[1].content.map((p: { text: string }) => p.text).join("")).toBe(promptText(MARKED.messages[0]!.content));
    expect(body.messages[1].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(body.messages[1].content[1].prompt_cache_breakpoint).toBeUndefined();
    // reads are counted at their own price, apart from input
    expect(c.usage).toEqual({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 0 });
  });

  it("no mark: explicit mode with no breakpoint, so nothing is written to the cache, and the text goes as it always has", async () => {
    for (const req of [PLAIN, BLOCKS_NO_MARK]) {
      const w = wire(OPENAI_REPLY);
      await openai({}, w).complete(req);
      const body = w.bodies[0];
      expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
      expect(body.messages[0].content).toBe(promptText(req.system));
      expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    }
  });

  it("streams the same request", async () => {
    const w = wire("");
    const t = openai({}, w);
    await (async () => {
      for await (const _ of t.stream!(MARKED)) void _;
    })().catch(() => {});
    expect(w.bodies[0].prompt_cache_options).toEqual({ mode: "explicit" });
    expect(w.bodies[0].messages[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
  });

  it("a model that doesn't document it, and every compatible or local server, get neither field and the flattened text", async () => {
    const configs: Partial<ProviderConfig>[] = [{ model: "gpt-4.1" }, { id: "compatible", preset: "openrouter", baseURL: "https://openrouter.example/api/v1", model: "gpt-6-luna" }, { id: "ollama", baseURL: "http://127.0.0.1:11434/v1", model: "gpt-6-luna", apiKey: null }];
    for (const over of configs) {
      const w = wire(OPENAI_REPLY);
      await openai(over, w).complete(MARKED);
      const body = w.bodies[0];
      expect(body.prompt_cache_options).toBeUndefined();
      expect(body.messages[0].content).toBe(promptText(MARKED.system));
      expect(body.messages[1].content).toBe(promptText(MARKED.messages[0]!.content));
    }
  });

  it("a refusal keeps the usage it was billed for", async () => {
    const w = wire({ ...OPENAI_REPLY, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, refusal: "no" } }] });
    const c = await openai({}, w).complete(PLAIN);
    expect(c).toMatchObject({ stop: "refusal", usage: { inputTokens: 1000, cacheReadTokens: 4000 } });
  });
});

describe("Anthropic: cache_control on marked blocks only", () => {
  const anthropic = (w: ReturnType<typeof wire>) => anthropicTransport({ id: "anthropic", model: "claude-sonnet-5-5", apiKey: "k", fetch: w.fetch, timeoutMs: 1000, maxRetries: 0 });

  it("a breakpoint where a block is marked, its text as written", async () => {
    const w = wire(ANTHROPIC_REPLY);
    const c = await anthropic(w).complete(MARKED);
    const body = w.bodies[0];
    expect(body.system).toEqual([
      { type: "text", text: "The rules every call shares.\n\n", cache_control: { type: "ephemeral" } },
      { type: "text", text: "It arrived Monday." },
    ]);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[1].cache_control).toBeUndefined();
    expect(c.usage).toEqual({ inputTokens: 900, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 0 });
  });

  it("no mark, no breakpoint", async () => {
    const w = wire(ANTHROPIC_REPLY);
    await anthropic(w).complete(PLAIN);
    expect(JSON.stringify(w.bodies[0])).not.toContain("cache_control");
  });
});
