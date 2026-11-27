/** Plan 292: the committed demo corpus holds every rule, builds the same twice, and has what the AI features need. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoCorpusDataset } from "./load";
import { DEMO_CORPUS_DIR, readCorpusSources } from "./node";
import { validateBulk, validateThreads, validateWorld } from "./rules";
import type { Seed } from "./types";

const { sources } = readCorpusSources(DEMO_CORPUS_DIR);
const seeds: Seed[] = readdirSync(join(DEMO_CORPUS_DIR, "seeds"))
  .filter((f) => /^batch-\d+\.json$/.test(f))
  .flatMap((f) => JSON.parse(readFileSync(join(DEMO_CORPUS_DIR, "seeds", f), "utf8")) as Seed[]);
const data = demoCorpusDataset(sources);
const anchor = Date.parse(sources.world.anchor);
const DAY = 86_400_000;
const written = data.messages.filter((m) => !m.bulk);

describe("the written demo mailbox (plan 292)", () => {
  it("passes every rule, and every seed was written", () => {
    const errors = [...validateWorld(sources.world), ...validateThreads(sources.world, sources.threads, seeds, sources.lists), ...validateBulk(sources.world, sources.bulk, sources.spam)].filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("builds the same mailbox twice", () => {
    expect(JSON.stringify(demoCorpusDataset(sources))).toBe(JSON.stringify(data));
  });

  it("is a real mailbox's size and mix: mostly English, a sixth or so Spanish, most of it machine mail", () => {
    expect(written.length).toBeGreaterThanOrEqual(2_500);
    expect(data.messages.length).toBeGreaterThanOrEqual(6_000);
    const spanish = written.filter((m) => sources.world.accounts[m.accountIndex]!.lang === "es").length / written.length;
    expect(spanish).toBeGreaterThan(0.08);
    expect(spanish).toBeLessThan(0.25);
  });

  it("has his sent mail of the last month for the follow-up scan, and every planted scenario", () => {
    expect(data.messages.filter((m) => m.isSent && anchor - m.date <= 30 * DAY).length).toBeGreaterThanOrEqual(150);
    const written = new Set(sources.threads.map((t) => t.id));
    const planted = seeds.filter((s) => s.plant);
    expect(planted.filter((s) => !written.has(s.id)).map((s) => s.id)).toEqual([]);
    expect(new Set(planted.map((s) => s.plant))).toEqual(new Set(["since", "top", "owner-promise", "promise-to-owner", "awaiting", "deadline", "waiting-on-you", "facts"]));
  });

  it("keeps ids unique: Message-IDs across the corpus, provider ids per account", () => {
    expect(new Set(data.messages.map((m) => m.rfcMessageId)).size).toBe(data.messages.length);
    expect(new Set(data.messages.map((m) => `${m.accountIndex}:${m.providerMsgId}`)).size).toBe(data.messages.length);
  });

  it("puts the demo day's newsletters among the newest, unread and in the Inbox, never in Updates", () => {
    const today = data.messages.filter((m) => m.listId && m.bulk && anchor - m.date < DAY);
    expect(today.length).toBeGreaterThan(0);
    for (const m of today) {
      expect(m).toMatchObject({ isRead: false, inInbox: true });
      expect(m.gmailLabels ?? []).not.toContain("CATEGORY_UPDATES");
    }
  });

  it("names in demo.json only what the mail holds (revision 8)", () => {
    const { manifest } = readCorpusSources(DEMO_CORPUS_DIR);
    expect(manifest).not.toBeNull();
    const p = manifest!.prepare;
    const bySubject = new Map(sources.threads.map((t) => [t.subject, t]));
    const named = [...p.since, p.sinceWhole, ...p.summaries, ...p.spanishReply, ...p.ask.flatMap((a) => a.cites)];
    expect(named.filter((s) => !bySubject.has(s))).toEqual([]);
    // the since conversations end in mail from others, unread, after mail he read
    for (const s of [...p.since, p.sinceWhole]) {
      const t = bySubject.get(s)!;
      expect(t.messages.at(-1)!).toMatchObject({ read: false });
      expect(t.messages.some((m) => m.from !== "me" && m.read)).toBe(true);
    }
    for (const s of p.spanishReply) expect(bySubject.get(s)!.lang).toBe("es");
    for (const a of p.ask) {
      const text = a.cites.map((s) => bySubject.get(s)!.messages.map((m) => m.text).join("\n")).join("\n");
      expect(a.facts.filter((f) => !text.includes(f))).toEqual([]);
    }
    // the starter rule's sender and the learning example's mail exist, and so does the category
    expect(data.messages.some((m) => m.from.email === manifest!.rule.from)).toBe(true);
    expect(data.messages.some((m) => m.from.email === manifest!.learningSender)).toBe(true);
    expect(data.categories.map((c) => c.name)).toContain(manifest!.rule.category);
    expect(data.messages.some((m) => m.from.email.endsWith(`@${p.ruleRequest.split(" ").at(-1)}`))).toBe(true);
  });

  it("reads like people: few em dashes, no message twice", () => {
    expect(written.filter((m) => m.bodyText.split("\n\n")[0]!.includes("—")).length / written.length).toBeLessThan(0.1);
    const bodies = sources.threads.flatMap((t) => t.messages.map((m) => m.text.trim()).filter((s) => s.split(/\s+/).length > 12));
    expect(bodies.length - new Set(bodies).size).toBe(0);
  });
});
