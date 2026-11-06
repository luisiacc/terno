/**
 * Plan 133 §2 and §3: the learner, through the real backend and SQLite. Everything's local unless a test says
 * otherwise; the store's rules are in the conformance suite, here what the learner does with them.
 */
import { AiError } from "@terno/ai";
import { RevisionError } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEARNER_KEY, STUDY_KEY, windowKey, type LearnerCheckpoint } from "./voice-learner";
import { cleanUp, errorOf, say, setup, START, TOM } from "./test/writing-fixture";

afterEach(cleanUp);

const rows = async (t: Awaited<ReturnType<typeof setup>>, accountId?: number) => (await t.backend.store.writing.profiles.list({ limit: 500, ...(accountId !== undefined ? { accountId } : {}) })).map((r) => `${r.scopeKey}|${r.language}|${r.samples}`);
const checkpoint = (t: Awaited<ReturnType<typeof setup>>) => t.backend.store.settings.get<LearnerCheckpoint | null>(LEARNER_KEY, null);

describe("waking", () => {
  it("plan 157: without AI it reads nothing, sends nothing and makes no checkpoint, whoever asks; AI coming starts it with no click", async () => {
    const t = await setup({ provider: "none" });
    await t.sentMany(30);
    const headers = vi.spyOn(t.backend.store.writing.corpus, "headers");
    t.backend.writing.learner.wake({ force: true });
    await t.client.call("writing.activate", {});
    await t.client.call("writing.profiles.list", { limit: 10 });
    await t.client.call("writing.prefs.set", { global: { useSentMail: true } });
    await t.backend.writing.learner.idle();
    expect(headers).not.toHaveBeenCalled();
    expect(await checkpoint(t)).toBeNull();
    await t.client.call("settings.update", { ai: { provider: "fake" } });
    await vi.waitFor(async () => expect(await checkpoint(t)).not.toBeNull());
    await t.backend.writing.learner.idle();
    expect(await rows(t)).toContain(`account:${t.account.id}||30`);
    expect(t.model.requests).toEqual([]);
  });

  it("plan 157: a launch with AI learns by itself; turned off, it doesn't", async () => {
    const t = await setup({ keep: true, provider: "none" });
    await t.sentMany(30);
    await t.backend.store.settings.update("app", {}, (s: Record<string, unknown>) => ({ value: { ...s, ai: { provider: "fake" } }, result: undefined }));
    await t.stop();
    const again = await setup({ dir: t.dir, keep: true });
    await vi.waitFor(async () => expect(await checkpoint(again)).not.toBeNull());
    await again.backend.writing.learner.idle();
    expect(await rows(again)).toContain(`account:${t.account.id}||30`);

    const off = await setup({ keep: true, provider: "none" });
    await off.sentMany(30);
    await off.client.call("writing.prefs.set", { global: { useSentMail: false } });
    await off.client.call("settings.update", { ai: { provider: "fake" } });
    await off.backend.writing.learner.idle();
    expect(await checkpoint(off)).toBeNull();
    await off.client.call("writing.prefs.set", { global: { useSentMail: true } });
    await off.backend.writing.learner.idle();
    expect(await rows(off)).toContain(`account:${off.account.id}||30`);
  });

  it("plan 157: turning Draft with AI back on starts it too", async () => {
    const t = await setup({ provider: "none" });
    await t.sentMany(30);
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    await t.client.call("settings.update", { ai: { provider: "fake" } });
    await t.backend.writing.learner.idle();
    expect(await checkpoint(t)).toBeNull();
    await t.client.call("writing.prefs.set", { global: { enabled: true } });
    await t.backend.writing.learner.idle();
    expect(await rows(t)).toContain(`account:${t.account.id}||30`);
  });

  it("plan 157: AI going stops what's running and keeps what was learned; status doesn't say it's learning", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    const learned = await rows(t);
    const headers = vi.spyOn(t.backend.store.writing.corpus, "headers");
    await t.client.call("settings.update", { ai: { provider: "none" } });
    await t.sentMany(30);
    t.backend.writing.learner.wake({ force: true });
    await t.backend.writing.learner.idle();
    expect(headers).not.toHaveBeenCalled();
    expect(await rows(t)).toEqual(learned);
    // a pass was due when it went: nothing's about to run it
    await t.backend.store.settings.set(LEARNER_KEY, { ...(await checkpoint(t))!, forced: [t.account.id] });
    await expect(t.backend.writing.learner.status()).resolves.toMatchObject({ state: "ready" });
  });

  it("plan 157: an imported provider is AI coming: it learns", async () => {
    const t = await setup({ provider: "none" });
    await t.sentMany(30);
    const file = await t.client.call("app.export", {});
    await t.client.call("app.import", { data: { ...file, settings: { ...file.settings, ai: { provider: "fake" } } } } as never);
    await vi.waitFor(async () => expect(await checkpoint(t)).not.toBeNull());
    await t.backend.writing.learner.idle();
    expect(await rows(t)).toContain(`account:${t.account.id}||30`);
  });

  it("after that it comes back on its own at the next start, resuming with no request from anyone", async () => {
    const t = await setup({ keep: true });
    await t.sentMany(30);
    await t.learned();
    await t.stop();
    const again = await setup({ dir: t.dir });
    await again.backend.writing.learner.idle();
    expect(await checkpoint(again)).not.toBeNull();
    expect(await rows(again)).toContain(`account:${t.account.id}||30`);
  });

  it("is idle when nothing changed: a wake reads the head and stops", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    const headers = vi.spyOn(t.backend.store.writing.corpus, "headers");
    const changes = vi.spyOn(t.backend.store.autocomplete, "changes");
    t.clock.now += 3600_000;
    t.backend.writing.learner.wake();
    await t.backend.writing.learner.idle();
    expect(headers).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it("a burst of changes reads the log once in its window, not once per change", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    const head = vi.spyOn(t.backend.store.autocomplete, "head");
    t.clock.now += 3600_000;
    for (let i = 0; i < 20; i++) {
      t.backend.writing.learner.wake();
      await t.backend.writing.learner.idle();
    }
    expect(head.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("what a pass counts", () => {
  it("builds every level that has enough mail, each from its own, with no consumer domain", async () => {
    const t = await setup();
    await t.sentMany(30, (i) => ({ to: [i % 2 ? TOM : { name: "Ana", email: "ana@acme.test" }] }));
    await t.sentMany(10, () => ({ to: [{ name: "Friend", email: "friend@gmail.com" }] }));
    await t.learned();
    const got = await rows(t);
    expect(got).toEqual(expect.arrayContaining([`account:${t.account.id}||40`, "you||40", `domain:${t.account.id}:acme.test||30`, `person:${t.account.id}:tom@acme.test||15`, `person:${t.account.id}:ana@acme.test||15`, `person:${t.account.id}:friend@gmail.com||10`]));
    expect(got.some((k) => k.includes("domain") && k.includes("gmail"))).toBe(false);
  });

  it("a domain needs two addresses; a person needs five; mass mail teaches neither", async () => {
    const t = await setup();
    await t.sentMany(20, () => ({ to: [{ name: "One", email: "one@solo.test" }] }));
    await t.sentMany(4, () => ({ to: [{ name: "Few", email: "few@solo2.test" }] }));
    await t.sentMany(6, () => ({ to: Array.from({ length: 8 }, (_, i) => ({ name: "", email: `p${i}@mass.test` })) }));
    await t.learned();
    const got = await rows(t);
    expect(got).toContain(`person:${t.account.id}:one@solo.test||20`);
    expect(got.some((k) => k.startsWith(`domain:${t.account.id}:solo.test`))).toBe(false);
    expect(got.some((k) => k.startsWith(`person:${t.account.id}:few@solo2.test`))).toBe(false);
    expect(got.some((k) => k.includes("mass.test"))).toBe(false);
  });

  it("counts what the user wrote: signature, quotes and repeated trailers out; stock phrases by counting, across people", async () => {
    const t = await setup();
    const word = ["budget", "plan", "launch", "copy", "invoice", "design", "report"];
    const body = (i: number) => `Thanks for the quick reply on the ${word[i % 7]}!\n\nOn Tuesday Ana wrote:\n> quoted canary${i}\n\nLet me know if that works for the ${word[(i + 3) % 7]}.\n\n--\nPepita Grillo\nFounder at Acme`;
    await t.sentMany(25, (i) => ({ bodyText: body(i), to: [{ name: "", email: `p${i % 5}@people.test` }] }));
    await t.learned();
    const [row] = await t.backend.store.writing.profiles.read([{ scopeKey: `account:${t.account.id}`, language: "" }]);
    const phrases = JSON.parse(row!.phrasesJson) as string[];
    expect(phrases.join()).toMatch(/quick reply|Let me know if that works/);
    expect(row!.phrasesJson + row!.habitsJson).not.toContain("canary");
    expect(row!.phrasesJson + row!.habitsJson).not.toContain("Founder");
  });

  it("keeps a language's own row when it has enough, and none when it's nearly all of them", async () => {
    const t = await setup();
    await t.sentMany(20, () => ({ bodyText: "Thanks for the update, that works for me and the team." }));
    await t.sentMany(12, () => ({ bodyText: "Muchas gracias por la información, me parece muy bien y lo vemos con el equipo.", to: [{ name: "Ana", email: "ana@acme.test" }] }));
    await t.learned();
    const got = await rows(t, t.account.id);
    expect(got).toContain(`account:${t.account.id}|en|20`);
    expect(got).toContain(`account:${t.account.id}|es|12`);
    expect(got.filter((k) => k.startsWith(`person:${t.account.id}:ana@acme.test`))).toEqual([`person:${t.account.id}:ana@acme.test||12`]);
  });

  it("leaves the model's unchanged text out of everything, and counts text the user changed", async () => {
    const t = await setup();
    await t.sentMany(25);
    const draft = (await t.backend.store.drafts.save({ accountId: t.account.id, subject: "s", bodyText: "b", to: [TOM], cc: [], bcc: [], mode: "new" } as never, START))!;
    await t.client.call("writing.commitGeneration", { accountId: t.account.id, draftId: draft.id, draftGeneration: draft.generation ?? "", address: TOM.email, text: "A model wrote this." });
    await t.client.call("compose.send", { accountId: t.account.id, to: [TOM], subject: "s", bodyText: "A model wrote this.", draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision, authoredText: "A model wrote this." });
    await t.learned();
    expect(await rows(t)).toContain(`account:${t.account.id}||25`);
    const window = await t.backend.store.settings.get<number[]>(windowKey(t.account.id), []);
    expect(window.length).toBe(25);
  });

  it("'you' is merged from the accounts' rows, reading no mail twice, and follows an account going", async () => {
    const t = await setup({ accounts: 2 });
    const [a, b] = t.accounts;
    await t.sentMany(30, () => ({ accountId: a!.id }));
    await t.sentMany(20, () => ({ accountId: b!.id }));
    await t.learned();
    expect(await rows(t)).toContain("you||50");
    await t.backend.store.accounts.remove(b!.id);
    t.clock.now += 3600_000;
    await t.learned();
    expect(await rows(t)).toContain("you||30");
  });
});

describe("catching up", () => {
  it("a new message, a late body, one trashed and one removed are all changes; a flag isn't", async () => {
    const t = await setup();
    const ids = await t.sentMany(30);
    await t.learned();
    const dirty = async () => (await checkpoint(t))!.dirty[String(t.account.id)] ?? 0;
    const tick = async () => {
      t.clock.now += 3600_000;
      t.backend.writing.learner.wake();
      await t.backend.writing.learner.idle();
    };
    // a pass waits for one in twenty of the window: 1 at 30 messages. So hold it off with a bigger window's rule…
    const pass = vi.spyOn(t.backend.store.writing.profiles, "commit");
    const { m } = await t.sent({ bodyText: null, bodyState: "none" });
    await tick();
    expect(pass).not.toHaveBeenCalled();
    expect(await dirty()).toBe(0);
    await t.backend.store.sync.ingest([{ ...m, bodyText: "Here it is, late.", bodyState: "full" }], { applyFilters: false, now: t.clock.now, classifier: null });
    await tick();
    expect(pass).toHaveBeenCalled();
    expect(await rows(t)).toContain(`account:${t.account.id}||31`);
    pass.mockClear();
    await t.backend.store.threads.act?.({ threadIds: [(await t.backend.store.writing.corpus.headers({ accountId: t.account.id, limit: 1 }))[0]!.threadId], action: { type: "star" } } as never).catch(() => {});
    await tick();
    expect(pass).not.toHaveBeenCalled();
    await t.backend.store.sync.remove([ids[0]!]);
    await tick();
    expect(await rows(t)).toContain(`account:${t.account.id}||30`);
  });

  it("a pass waits for enough change on a large window, and the count survives a restart", async () => {
    const t = await setup({ keep: true });
    await t.sentMany(200);
    await t.learned();
    const commit = vi.spyOn(t.backend.store.writing.profiles, "commit");
    for (let i = 0; i < 3; i++) await t.sent({ date: t.clock.now });
    t.clock.now += 3600_000;
    await t.learned();
    expect(commit).not.toHaveBeenCalled();
    expect((await checkpoint(t))!.dirty[String(t.account.id)]).toBe(3);
    await t.stop();
    const again = await setup({ dir: t.dir });
    await again.backend.writing.learner.idle();
    expect((await checkpoint(again))!.dirty[String(t.account.id)]).toBe(3);
    for (let i = 0; i < 7; i++) await again.sent({ date: again.clock.now, accountId: t.account.id });
    again.clock.now += 3600_000;
    await again.learned();
    expect((await checkpoint(again))!.dirty[String(t.account.id)] ?? 0).toBe(0);
    expect(await rows(again)).toContain(`account:${t.account.id}||210`);
  });

  it("a log pruned past the checkpoint costs a walk of headers, and finds the same changes", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    await t.sent({ date: t.clock.now });
    vi.spyOn(t.backend.store.autocomplete, "changes").mockRejectedValue(new RevisionError("gap", "pruned"));
    t.clock.now += 3600_000;
    await t.learned();
    expect(await rows(t)).toContain(`account:${t.account.id}||31`);
  });

  it("runs beside the phrase model, on the same log, without disturbing it", async () => {
    const t = await setup();
    await t.sentMany(40);
    await Promise.all([t.backend.warmAutocomplete(), t.learned()]);
    await t.backend.autocomplete.idle?.();
    expect(await rows(t)).toContain(`account:${t.account.id}||40`);
    expect(t.backend.autocomplete.suggestRecipients("tom").items.map((h) => h.email)).toContain(TOM.email);
  });
});

describe("a checkpoint is atomic", () => {
  it("a commit that fails writes nothing, and the pass runs again", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.backend.writing.learner.activate();
    await t.backend.writing.learner.idle();
    const before = await rows(t);
    await t.sent({ date: t.clock.now });
    const commit = vi.spyOn(t.backend.store.writing.profiles, "commit").mockRejectedValueOnce(new Error("disk full"));
    t.clock.now += 3600_000;
    await t.learned();
    expect(commit).toHaveBeenCalled();
    expect(await rows(t)).toEqual(before);
    expect((await t.backend.store.settings.get<number[]>(windowKey(t.account.id), [])).length).toBe(30);
    t.clock.now += 3600_000;
    await t.learned();
    expect(await rows(t)).toContain(`account:${t.account.id}||31`);
  });

  it("stopped in the middle of an account, nothing of it is written; the next start does that account, not the one finished", async () => {
    const t = await setup({ accounts: 2, keep: true });
    const [a, b] = t.accounts;
    await t.sentMany(30, () => ({ accountId: a!.id }));
    await t.sentMany(30, () => ({ accountId: b!.id }));
    // stop as the second account's bodies start
    const texts = t.backend.store.writing.corpus.texts;
    let stopping: Promise<void> | null = null;
    vi.spyOn(t.backend.store.writing.corpus, "texts").mockImplementation(async (ids) => {
      const headers = await t.backend.store.writing.corpus.usable(ids);
      const isB = (await t.backend.store.writing.corpus.headers({ accountId: b!.id, limit: 50 })).some((h) => headers.includes(h.id));
      if (isB && !stopping) stopping = t.backend.writing.learner.stop();
      return texts(ids);
    });
    await t.backend.writing.learner.activate();
    await t.backend.writing.learner.idle();
    expect(await rows(t, a!.id)).toContain(`account:${a!.id}||30`);
    expect(await rows(t, b!.id)).toEqual([]);
    await t.stop();

    const again = await setup({ dir: t.dir });
    const headers = vi.spyOn(again.backend.store.writing.corpus, "headers");
    await again.backend.writing.learner.idle();
    expect(await rows(again, b!.id)).toContain(`account:${b!.id}||30`);
    expect(headers.mock.calls.some(([p]) => p.accountId === a!.id)).toBe(false);
  });
});

describe("what the user controls", () => {
  it("an edit pins: a pass counts what's new and leaves the words alone; Reset gives it back", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    const scopeKey = `person:${t.account.id}:tom@acme.test`;
    const edited = await t.client.call("writing.profiles.edit", { scopeKey, phrases: ["my own words"] });
    expect(edited).toMatchObject({ edited: true, phrases: ["my own words"], newSince: 0 });
    await t.sent({ date: t.clock.now });
    t.clock.now += 3600_000;
    await t.learned();
    const { items } = await t.client.call("writing.profiles.list", { accountId: t.account.id });
    expect(items.find((p) => p.scopeKey === scopeKey)).toMatchObject({ edited: true, phrases: ["my own words"], newSince: 1, samples: 31 });
    await t.client.call("writing.profiles.reset", { scopeKey });
    await t.backend.writing.learner.idle();
    const after = await t.client.call("writing.profiles.list", { accountId: t.account.id });
    expect(after.items.find((p) => p.scopeKey === scopeKey)).toMatchObject({ edited: false, samples: 31 });
    expect(after.items.find((p) => p.scopeKey === scopeKey)!.phrases).not.toContain("my own words");
    expect((await errorOf(t.client.call("writing.profiles.edit", { scopeKey: "person:1:nobody@x.test", phrases: [] }))).code).toBe("NOT_FOUND");
  });

  it("Rebuild counts again, Clear all forgets everything and sleeps until used", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    const headers = vi.spyOn(t.backend.store.writing.corpus, "headers");
    await t.client.call("writing.profiles.rebuild", { accountId: t.account.id });
    await t.backend.writing.learner.idle();
    expect(headers).toHaveBeenCalled();
    await t.client.call("writing.profiles.clear", {});
    expect(await rows(t)).toEqual([]);
    expect(await checkpoint(t)).toBeNull();
    headers.mockClear();
    t.clock.now += 3600_000;
    t.backend.writing.learner.wake({ force: true });
    await t.backend.writing.learner.idle();
    expect(headers).not.toHaveBeenCalled();
    await t.compose();
    await t.backend.writing.learner.idle();
    expect(await rows(t)).toContain(`account:${t.account.id}||30`);
  });

  it("'Learn from my sent mail' off stops the job and takes the judgments; drafts then use no voice and no examples", async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    await t.backend.store.writing.profiles.judge({ scopeKey: `account:${t.account.id}`, language: "", judgmentJson: JSON.stringify({ traits: { formality: 1, warmth: 1, directness: 1, detail: 1, humor: 0 }, notes: [] }), sampleHash: "h", model: "m", provider: "p", promptVersion: 1, now: START });
    await t.client.call("writing.prefs.set", { global: { useSentMail: false } });
    const [row] = await t.backend.store.writing.profiles.read([{ scopeKey: `account:${t.account.id}`, language: "" }]);
    expect(row!.judgmentJson).toBeNull();
    const headers = vi.spyOn(t.backend.store.writing.corpus, "headers");
    await t.sent({ date: t.clock.now });
    t.clock.now += 3600_000;
    await t.learned();
    expect(headers).not.toHaveBeenCalled();
    const r = await t.compose({ session: "off" });
    expect(r).toMatchObject({ status: "done", used: { levels: [], examples: 0, history: "none" } });
    expect((await t.client.call("writing.profiles.list", {})).status.state).toBe("off");
    // and back on, it catches up
    await t.client.call("writing.prefs.set", { global: { useSentMail: true } });
    await t.backend.writing.learner.idle();
    expect(await rows(t)).toContain(`account:${t.account.id}||31`);
  });

  it("per account: one account off, the other goes on", async () => {
    const t = await setup({ accounts: 2 });
    const [a, b] = t.accounts;
    await t.client.call("writing.prefs.set", { account: { accountId: a!.id, prefs: { useSentMail: false } } });
    await t.sentMany(30, () => ({ accountId: a!.id }));
    await t.sentMany(30, () => ({ accountId: b!.id }));
    await t.learned();
    expect(await rows(t, a!.id)).toEqual([]);
    expect(await rows(t, b!.id)).toContain(`account:${b!.id}||30`);
    expect(await rows(t)).toContain("you||30");
  });
});

describe("the optional model step (§3)", () => {
  const prepared = async (o: { provider?: "fake" | "none"; accounts?: number } = {}) => {
    const t = await setup(o);
    await t.sentMany(30);
    await t.learned();
    expect(t.model.requests).toEqual([]);
    const heard: { state: string; done: number; total: number; errorKind?: string }[] = [];
    t.client.on("aiStudy", (e) => heard.push(e));
    const finish = async () => {
      for (let i = 0; i < 200 && !["done", "failed", "cancelled"].includes(heard[heard.length - 1]?.state ?? ""); i++) await new Promise((r) => setTimeout(r, 5));
    };
    const consent = () => t.backend.store.settings.get(STUDY_KEY, null);
    return { ...t, heard, finish, consent };
  };

  it("sends nothing and stores no consent until confirmed, on a cloud provider; a local one has nothing to ask", async () => {
    const t = await prepared();
    vi.spyOn(await t.backend.aiService.forTask("voice", { foreground: false }), "local", "get").mockReturnValue(false);
    const asked = await t.client.call("writing.studyStyle", { requestId: "st1" });
    expect(asked).toMatchObject({ status: "consent", provider: "fake", accountIds: [t.account.id] });
    expect((asked as { messages: number }).messages).toBeGreaterThan(0);
    expect((asked as { tokens: number }).tokens).toBeGreaterThan(0);
    expect(t.model.requests).toEqual([]);
    expect(await t.consent()).toBeNull();
    // the wrong provider, or leaving out an account: asks again
    expect(await t.client.call("writing.studyStyle", { requestId: "st2", confirm: { provider: "anthropic", accountIds: [t.account.id] } })).toMatchObject({ status: "consent" });
    expect(await t.client.call("writing.studyStyle", { requestId: "st3", confirm: { provider: "fake", accountIds: [] } })).toMatchObject({ status: "consent" });
    expect(t.model.requests).toEqual([]);
  });

  it("runs through the limiter, stores traits and notes, and the next draft uses them; the same sample asks nothing twice", async () => {
    const t = await prepared();
    const r = await t.client.call("writing.studyStyle", { requestId: "st4", confirm: { provider: "fake", accountIds: [t.account.id] } });
    expect(r.status).toBe("started");
    await t.finish();
    expect(t.heard[t.heard.length - 1]).toMatchObject({ state: "done", done: (r as { total: number }).total });
    const { items } = await t.client.call("writing.profiles.list", {});
    expect(items.find((p) => p.scope === "account")!.judgment).toMatchObject({ traits: { directness: 4 }, notes: ["Answers first, adds nothing"] });
    expect(await t.consent()).toMatchObject({ provider: "fake", accountIds: [t.account.id] });
    const asked = t.model.requests.length;
    expect(asked).toBeGreaterThan(0);
    await t.compose({ session: "with-judgment" });
    const prompt = JSON.stringify(t.model.requests[t.model.requests.length - 1]!.messages);
    expect(prompt).toContain("manner:");
    expect(prompt).toContain("note: Answers first");
    // again: same sample, same prompt, same model
    const before = t.model.requests.length;
    t.heard.length = 0;
    await t.client.call("writing.studyStyle", { requestId: "st5", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await t.finish();
    expect(t.model.requests.length).toBe(before);
  });

  it("its failures are named, never spent twice, and the local profile is untouched; cancel stops it", async () => {
    const t = await prepared();
    t.model.answer = () => ({ text: "not json at all", stop: "end" });
    await t.client.call("writing.studyStyle", { requestId: "st6", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await t.finish();
    expect(t.heard[t.heard.length - 1]).toMatchObject({ state: "failed", errorKind: "invalid_output" });
    const { items } = await t.client.call("writing.profiles.list", { scope: "account" });
    expect(items[0]!.judgment).toBeNull();
    t.heard.length = 0;
    let started = false;
    t.model.answer = async (req) => {
      started = true;
      await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      throw new Error("never");
    };
    await t.client.call("writing.studyStyle", { requestId: "st7", confirm: { provider: "fake", accountIds: [t.account.id] } });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    await t.client.call("ai.cancel", { requestId: "st7" });
    await t.finish();
    expect(t.heard[t.heard.length - 1]!.state).toBe("cancelled");
  });

  it("refreshes only with consent still standing, after enough new mail, within the day's budget; a changed provider stops it", async () => {
    const t = await prepared();
    await t.client.call("writing.studyStyle", { requestId: "st8", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await t.finish();
    const before = t.model.requests.length;
    // less than 20 new: a pass may run, no judgment moves for the account
    await t.sentMany(3, (i) => ({ date: t.clock.now + i }));
    t.clock.now += 3600_000;
    await t.learned();
    const afterFew = t.model.requests.length;
    expect(afterFew).toBe(before);
    await t.sentMany(25, (i) => ({ date: t.clock.now + i, bodyText: `A fresh line of text ${i}, thanks.` }));
    t.clock.now += 3600_000;
    await t.learned();
    expect(t.model.requests.length).toBeGreaterThan(afterFew);
    // consent for another provider sends nothing more
    await t.backend.store.settings.set(STUDY_KEY, { provider: "anthropic", accountIds: [t.account.id], at: START });
    const atChange = t.model.requests.length;
    await t.sentMany(25, (i) => ({ date: t.clock.now + i, bodyText: `Another fresh line of text ${i}, thanks.` }));
    t.clock.now += 3600_000;
    await t.learned();
    expect(t.model.requests.length).toBe(atChange);
  });

  describe("what's new since a judgment (plan 133 review)", () => {
    const newSince = async (t: Awaited<ReturnType<typeof prepared>>) => (await t.backend.store.writing.profiles.list({ scope: "account", accountId: t.account.id, limit: 1 }))[0]!.newSince;

    it("a full window keeps refreshing: mail coming in counts though the same number left", async () => {
      const t = await prepared();
      await t.client.call("writing.studyStyle", { requestId: "new1", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await t.finish();
      const size = (await t.backend.store.writing.profiles.list({ scope: "account", accountId: t.account.id, limit: 1 }))[0]!.samples;
      expect(await newSince(t)).toBe(0);
      const before = t.model.requests.length;
      // as a full window does: the oldest leave as the new arrive, so the samples don't grow
      const oldest = (await t.backend.store.writing.corpus.headers({ accountId: t.account.id, limit: 500 })).slice(-25).map((h) => h.id);
      await t.backend.store.sync.remove(oldest);
      await t.sentMany(25, (i) => ({ date: t.clock.now + i, bodyText: `A fresh line of text ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.learned();
      const row = (await t.backend.store.writing.profiles.list({ scope: "account", accountId: t.account.id, limit: 1 }))[0]!;
      expect(row.samples).toBe(size);
      expect(t.model.requests.length).toBeGreaterThan(before);
    });

    it("counts per scope: mail to Tom moves Tom's row and the account's, not someone else's", async () => {
      const t = await setup();
      const ana = { name: "Ana", email: "ana@acme.test" };
      await t.sentMany(20);
      await t.sentMany(20, () => ({ to: [ana] }));
      await t.learned();
      const row = async (address: string) => (await t.backend.store.writing.profiles.read([{ scopeKey: `person:${t.account.id}:${address}`, language: "" }]))[0]!;
      const account = async () => (await t.backend.store.writing.profiles.read([{ scopeKey: `account:${t.account.id}`, language: "" }]))[0]!;
      expect((await row(ana.email)).newSince).toBe(0);
      await t.sentMany(6, (i) => ({ date: t.clock.now + i, bodyText: `Another line for Tom ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.backend.writing.learner.rebuild(t.account.id);
      await t.learned();
      expect((await row(TOM.email)).newSince).toBe(6);
      expect((await row(ana.email)).newSince).toBe(0);
      expect((await account()).newSince).toBe(6);
    });

    it("what's new on \"you\" follows what its accounts incorporated", async () => {
      const t = await setup();
      await t.sentMany(30);
      await t.learned();
      const you = async () => (await t.backend.store.writing.profiles.read([{ scopeKey: "you", language: "" }]))[0]!;
      const first = (await you()).newSince;
      await t.sentMany(6, (i) => ({ date: t.clock.now + i, bodyText: `Another line ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.backend.writing.learner.rebuild(t.account.id);
      await t.learned();
      expect((await you()).newSince).toBe(first + 6);
    });

    it("a pass that stops part way leaves what's new to the pass that finishes: nothing counted twice", async () => {
      const t = await setup();
      await t.sentMany(30);
      await t.learned();
      await t.sentMany(6, (i) => ({ date: t.clock.now + i, bodyText: `Another line ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.backend.writing.learner.rebuild(t.account.id);
      const real = t.backend.store.writing.profiles.commit.bind(t.backend.store.writing.profiles);
      // the commit that holds the window fails, the way a stop or a crash would leave it
      vi.spyOn(t.backend.store.writing.profiles, "commit").mockImplementation(async (c) => {
        if (Object.keys(c.state).length) throw new Error("stopped here");
        return real(c);
      });
      await t.learned();
      vi.mocked(t.backend.store.writing.profiles.commit).mockRestore();
      await t.backend.writing.learner.rebuild(t.account.id);
      await t.learned();
      expect((await t.backend.store.writing.profiles.read([{ scopeKey: `account:${t.account.id}`, language: "" }]))[0]!.newSince).toBe(6);
    });
  });

  describe("consent follows where the mail goes (plan 133 review)", () => {
    const moreMail = async (t: Awaited<ReturnType<typeof prepared>>, word: string) => {
      await t.sentMany(25, (i) => ({ date: t.clock.now + i, bodyText: `A ${word} line of text ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.learned();
    };

    it("a study on a local endpoint never authorizes a refresh on a cloud service", async () => {
      const t = await prepared();
      await t.client.call("writing.studyStyle", { requestId: "dest1", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await t.finish();
      expect(await t.consent()).toMatchObject({ provider: "fake", destination: expect.stringContaining('"local":true') });
      const before = t.model.requests.length;
      // the same provider and id, now somewhere that isn't this machine
      vi.spyOn(await t.backend.aiService.forTask("voice", { foreground: false }), "local", "get").mockReturnValue(false);
      await moreMail(t, "fresh");
      expect(t.model.requests.length).toBe(before);
    });

    it("another server of the same kind needs its own consent", async () => {
      const t = await prepared();
      await t.client.call("writing.studyStyle", { requestId: "dest2", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await t.finish();
      const before = t.model.requests.length;
      const ai = await t.backend.aiService.forTask("voice", { foreground: false });
      Object.defineProperty(ai, "endpoint", { value: "https://elsewhere.example/v1", configurable: true });
      await moreMail(t, "fresh");
      expect(t.model.requests.length).toBe(before);
    });

    it("a confirm that names only the provider isn't agreement: the destination has to be the one asked about", async () => {
      const t = await prepared();
      const ai = await t.backend.aiService.forTask("voice", { foreground: false });
      vi.spyOn(ai, "local", "get").mockReturnValue(false);
      const asked = await t.client.call("writing.studyStyle", { requestId: "dest3" });
      if (asked.status !== "consent") throw new Error("expected consent");
      expect(await t.client.call("writing.studyStyle", { requestId: "dest4", confirm: { provider: "fake", accountIds: [t.account.id] } })).toMatchObject({ status: "consent" });
      // agreed to one place; it now points at another
      Object.defineProperty(ai, "endpoint", { value: "https://elsewhere.example/v1", configurable: true });
      expect(await t.client.call("writing.studyStyle", { requestId: "dest5", confirm: { provider: "fake", destination: asked.destination, accountIds: [t.account.id] } })).toMatchObject({ status: "consent" });
      expect(t.model.requests).toEqual([]);
      expect(await t.consent()).toBeNull();
      const again = await t.client.call("writing.studyStyle", { requestId: "dest6" });
      if (again.status !== "consent") throw new Error("expected consent");
      expect(await t.client.call("writing.studyStyle", { requestId: "dest7", confirm: { provider: "fake", destination: again.destination, accountIds: [t.account.id] } })).toMatchObject({ status: "started" });
      await t.finish();
    });

    it("what a consent didn't name stays out: an account added after it", async () => {
      const t = await prepared({ accounts: 2 });
      const [a, b] = t.accounts;
      await t.client.call("writing.studyStyle", { requestId: "dest8", confirm: { provider: "fake", accountIds: [a!.id, b!.id] } });
      await t.finish();
      const stored = (await t.consent()) as unknown as { accountIds: number[] };
      await t.backend.store.settings.set(STUDY_KEY, { ...stored, accountIds: [a!.id] });
      const before = t.model.requests.length;
      await t.sentMany(25, (i) => ({ accountId: b!.id, date: t.clock.now + i, bodyText: `canary-unnamed ${i}, thanks.` }));
      t.clock.now += 3600_000;
      await t.learned();
      for (const req of t.model.requests.slice(before)) expect(JSON.stringify(req.messages)).not.toContain("canary-unnamed");
    });

    it("a consent from before destinations were kept refreshes nothing until it's asked again", async () => {
      const t = await prepared();
      await t.client.call("writing.studyStyle", { requestId: "dest9", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await t.finish();
      await t.backend.store.settings.set(STUDY_KEY, { provider: "fake", accountIds: [t.account.id], at: START });
      const before = t.model.requests.length;
      await moreMail(t, "fresh");
      expect(t.model.requests.length).toBe(before);
    });
  });

  describe("a permission taken back (plan 133 review)", () => {
    const holdingModel = (t: Awaited<ReturnType<typeof prepared>>) => {
      t.model.answer = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")), { once: true }));
    };

    it.each([
      ["drafting off", { global: { enabled: false } }],
      ["learning off", { global: { useSentMail: false } }],
    ])("%s stops a study at the provider, and no judgment lands", async (_name, patch) => {
      const t = await prepared();
      holdingModel(t);
      await t.client.call("writing.studyStyle", { requestId: "perm1", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await vi.waitFor(() => expect(t.model.requests.length).toBeGreaterThan(0));
      await t.client.call("writing.prefs.set", patch);
      expect(t.model.requests[0]!.signal.aborted).toBe(true);
      await t.finish();
      expect(t.heard[t.heard.length - 1]!.state).toBe("cancelled");
      const rows = await t.backend.store.writing.profiles.list({ limit: 50 });
      expect(rows.every((r) => r.judgmentJson === null)).toBe(true);
    });

    it("Clear stops a study at the provider, and a consent isn't written back afterward", async () => {
      const t = await prepared();
      holdingModel(t);
      await t.client.call("writing.studyStyle", { requestId: "perm2", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await vi.waitFor(() => expect(t.model.requests.length).toBeGreaterThan(0));
      await t.client.call("writing.profiles.clear", {});
      expect(t.model.requests[0]!.signal.aborted).toBe(true);
      await t.finish();
      expect(await t.consent()).toBeNull();
    });

    it("learning off stops a refresh at the provider", async () => {
      const t = await prepared();
      await t.client.call("writing.studyStyle", { requestId: "perm3", confirm: { provider: "fake", accountIds: [t.account.id] } });
      await t.finish();
      const before = t.model.requests.length;
      holdingModel(t);
      await t.sentMany(25, (i) => ({ date: t.clock.now + i, bodyText: `A fresh line of text ${i}, thanks.` }));
      t.clock.now += 3600_000;
      const learning = t.learned();
      await vi.waitFor(() => expect(t.model.requests.length).toBeGreaterThan(before));
      await t.client.call("writing.prefs.set", { global: { useSentMail: false } });
      expect(t.model.requests[before]!.signal.aborted).toBe(true);
      await learning;
    });
  });

  it("nothing to study before there's enough mail; no provider says so plainly and sends nothing", async () => {
    const empty = await setup();
    expect(await empty.client.call("writing.studyStyle", { requestId: "st9" })).toEqual({ status: "nothing" });
    const none = await prepared({ provider: "none" });
    const e = await errorOf(none.client.call("writing.studyStyle", { requestId: "st10", confirm: { provider: "fake", accountIds: [none.account.id] } }));
    expect(e.details?.aiErrorKind).toBe("not_configured");
    expect(none.model.requests).toEqual([]);
  });
});

void say;
