import { describe, expect, it } from "vitest";
import { DraftTooLargeError, fitDraftBudget, headAndTail, type DraftParts } from "./budget";
import { checkSpecifics, findPlaceholders } from "./checks";
import { countWords, detectWritingLanguage, normalizeGreeting, normalizeSignOff, readCorpus, repeatedTrailers, writtenText } from "./extract";
import { computeHabits, stockPhrases } from "./habits";
import { resolveIntent, type ContactLookup, type IntentPerson } from "./intent";
import { ALL_PARTS, renderHabits, renderLevel, renderVoices } from "./render";
import { chooseExamples, chooseSample, SAMPLE_LIMITS, sampleable } from "./sample";
import { rejectNote, screenNotes } from "./screen";
import type { Habits, SentMail, VoiceProfile, WrittenMail } from "./types";

const DAY = 86_400_000;

function written(text: string, over: Partial<WrittenMail> = {}): WrittenMail {
  return { id: over.id ?? text, to: ["a@x.example"], cc: [], at: 0, isReply: true, bulk: false, fromModel: false, text, words: countWords(text), greeting: normalizeGreeting(text), signOff: normalizeSignOff(text, ["Tom"]), language: detectWritingLanguage(text), ...over };
}

describe("the extractor", () => {
  it("keeps an answer written below a quoted question, unlike ownText", () => {
    const body = "On Mon, 3 Mar 2026, Ana <ana@x.example> wrote:\n> Can you do Friday?\n\nYes, Friday works.\n\n> And the budget?\n\nStill waiting on it.";
    expect(writtenText(body)).toBe("Yes, Friday works.\n\nStill waiting on it.");
  });

  it("removes top-posted quotes, whatever the language", () => {
    expect(writtenText("Sounds good.\n\nEl 3 mar 2026, Ana escribió:\n> ¿Vienes?")).toBe("Sounds good.");
  });

  it("drops an attribution with no quote marks below it, and all that follows", () => {
    expect(writtenText("Fine by me.\n\nOn Mon, Ana wrote:\nThe original, unmarked.")).toBe("Fine by me.");
  });

  it("stops at forwarded and Outlook blocks", () => {
    expect(writtenText("FYI\n\n---------- Forwarded message ----------\nFrom: x@y.example\nSecret")).toBe("FYI");
    expect(writtenText("See below.\n\nFrom: Ana <ana@x.example>\nSent: Monday\nTo: Tom\nOld mail")).toBe("See below.");
  });

  it("strips the exact signature as a suffix and leaves the same words mid-text", () => {
    const signature = "Tom Reed\nAcme Inc";
    expect(writtenText("All good.\n\nTom Reed\nAcme Inc", { signature })).toBe("All good.");
    expect(writtenText("Tom Reed\nAcme Inc called. All good.", { signature })).toBe("Tom Reed\nAcme Inc called. All good.");
    expect(writtenText("All good.\n\nOn Mon, Ana wrote:\n> q\n\nTom Reed\nAcme Inc", { signature })).toBe("All good.");
  });

  it("drops the -- block but keeps text below a later quote", () => {
    expect(writtenText("Done.\n-- \nTom\nAcme\n\nOn Mon, Ana wrote:\n> q\n\nAlso this.")).toBe("Done.\n\nAlso this.");
  });

  it("finds trailing lines repeated across messages, and leaves closings alone: they're habits", () => {
    const bodies = Array.from({ length: 8 }, (_, i) => `Message ${i} about something.\n\nBest,\nHead of Sales at Acme`);
    const trailers = repeatedTrailers(bodies);
    expect(trailers.has("Head of Sales at Acme")).toBe(true);
    expect(trailers.has("Best,")).toBe(false);
    expect(writtenText(bodies[0]!, { trailers })).toBe("Message 0 about something.\n\nBest,");
  });

  it("takes off device lines", () => {
    expect(writtenText("ok\n\nSent from my iPhone")).toBe("ok");
  });

  it("normalizes greetings, keeping titles and groups", () => {
    expect(normalizeGreeting("Hi Tom,\nmore")).toBe("Hi {name},");
    expect(normalizeGreeting("hey tom - got it")).toBe("hey {name in lowercase}-");
    expect(normalizeGreeting("Estimado Sr. García:\nle escribo")).toBe("Estimado Sr. {name}:");
    expect(normalizeGreeting("Hi all,")).toBe("Hi all,");
    expect(normalizeGreeting("Hola!")).toBe("Hola!");
    expect(normalizeGreeting("Tom,\nok")).toBe("{name},");
    expect(normalizeGreeting("tom,\nok", ["Tom"])).toBe("{name in lowercase},");
    expect(normalizeGreeting("Yes,\nok")).toBeNull();
    expect(normalizeGreeting("thats fine")).toBeNull();
    expect(normalizeGreeting("hi can you send it")).toBe("hi");
    expect(normalizeGreeting("IVY!! omg yes", ["Ivy", "Marsh"])).toBe("{NAME IN CAPITALS}!!");
  });

  it("keeps sign-offs as typed and doesn't mistake a one-liner for one", () => {
    expect(normalizeSignOff("All good.\n\nBest,\nTom", ["Tom Reed"])).toBe("Best,\nTom");
    expect(normalizeSignOff("All good.\n-t", ["Tom Reed"])).toBe("-t");
    expect(normalizeSignOff("All good.\nThanks!", ["Tom Reed"])).toBe("Thanks!");
    expect(normalizeSignOff("All good.\nTom", ["Tom Reed"])).toBe("Tom");
    expect(normalizeSignOff("Thanks!", ["Tom Reed"])).toBeNull();
    expect(normalizeSignOff("Hi Mum!\n\nYes.\n\nLove you lots,\nB xx", ["Bea"])).toBe("Love you lots,\nB xx");
    expect(normalizeSignOff("Le escribo por el contrato.\n\nReciba un cordial saludo,\nRodrigo", ["Rodrigo Aldana"])).toBe("Reciba un cordial saludo,\nRodrigo");
    expect(normalizeSignOff("One thing.\nAnother thing that is not a closing.", ["Tom"])).toBeNull();
  });

  it("reads a corpus per account, with names", () => {
    const mails: SentMail[] = [{ id: 1, to: ["tom@x.example"], cc: [], at: 1, body: "hey tom,\nyep\n-m", isReply: true }];
    const [m] = readCorpus(mails, { selfNames: ["Milo"], namesOf: () => ["Tom"] });
    expect(m).toMatchObject({ greeting: "hey {name in lowercase},", signOff: "-m" });
  });
});

describe("habits", () => {
  it("count before de-duplication: fifty Thanks! make someone terse", () => {
    const thanks = Array.from({ length: 50 }, (_, i) => written("Thanks!", { id: i }));
    const long = Array.from({ length: 10 }, (_, i) => written("A much longer message that goes on for quite a number of words about something.", { id: 100 + i }));
    const habits = computeHabits([...thanks, ...long]);
    expect(habits.messages).toBe(60);
    expect(habits.words.median).toBe(1);
    expect(habits.exclamation).toBeCloseTo(0.83, 2);
    // the sample, by contrast, sees each only once
    expect(sampleable([...thanks, ...long]).length).toBe(2);
  });

  it("track greetings, sign-offs, language, replies and one-to-one", () => {
    const habits = computeHabits([
      written("Hi Tom,\nThe report is on the way and it will be with you soon.\nBest,\nTom", { isReply: true, greeting: "Hi {name},", signOff: "Best,\nTom" }),
      written("Hi Sam,\nThe plan is for you to read it and tell me.\nBest,\nTom", { isReply: false, to: ["a@x.example", "b@x.example"], greeting: "Hi {name},", signOff: "Best,\nTom" }),
      written("hola, que tal, te escribo para ver como va el proyecto de la casa", { greeting: "hola,", signOff: null }),
      written("sent you the file 😀\nbye", { greeting: null, signOff: null }),
    ]);
    expect(habits.greetings[0]).toEqual({ text: "Hi {name},", share: 0.5 });
    expect(habits.signOffs[0]).toEqual({ text: "Best,\nTom", share: 0.5 });
    // a greeting and a sign-off aren't sentences: this one's body is 14 words and 12
    expect(habits.sentenceWords).toBeGreaterThanOrEqual(7);
    expect(habits.noSignOff).toBe(0.5);
    expect(habits.languages.map((l) => l.text).sort()).toEqual(["en", "es"]);
    expect(habits.replies).toBe(0.75);
    expect(habits.oneToOne).toBe(0.75);
    expect(habits.emoji).toBe(0.25);
    expect(habits.lowercase).toBe(0.5);
  });
});

describe("stock phrases", () => {
  it("need 3+ messages and 2+ recipients", () => {
    const mails = [
      written("let me know if that works", { id: 1, to: ["a@x.example"] }),
      written("well let me know if that works today", { id: 2, to: ["b@x.example"] }),
      written("ok let me know if that works", { id: 3, to: ["a@x.example"] }),
      written("the biopsy came back clean", { id: 4, to: ["c@x.example"] }),
      written("the biopsy came back clean", { id: 5, to: ["c@x.example"] }),
      written("the biopsy came back clean", { id: 6, to: ["c@x.example"] }),
    ];
    const phrases = stockPhrases(mails);
    expect(phrases).toContain("let me know if that works");
    expect(phrases.some((p) => p.includes("biopsy"))).toBe(false);
  });

  it("carry no digits, don't cross sentences, and keep only the longest of a family", () => {
    const mails = [1, 2, 3].map((id) => written(`invoice 42 goes out today. thanks for your help with this project`, { id, to: [`r${id}@x.example`] }));
    const phrases = stockPhrases(mails);
    expect(phrases.filter((p) => /\d/.test(p))).toEqual([]);
    expect(phrases).toContain("thanks for your help with this project");
    expect(phrases).not.toContain("thanks for your help");
    expect(phrases.some((p) => p.includes("today thanks"))).toBe(false);
  });

  it("leave out fragments that start or stop on a function word, in both languages", () => {
    const mails = [1, 2, 3].map((id) => written(`thank you for the certificate of the house. el certificado de la calle mayor`, { id, to: [`r${id}@x.example`] }));
    const phrases = stockPhrases(mails);
    expect(phrases).not.toContain("thank you for");
    expect(phrases).not.toContain("de la calle");
    expect(phrases).not.toContain("el certificado de");
  });

  it("keep at most eight words", () => {
    const long = "one two three four five six seven eight nine ten eleven";
    const phrases = stockPhrases([1, 2, 3].map((id) => written(long, { id, to: [`r${id}@x.example`] })));
    expect(Math.max(...phrases.map((p) => p.split(" ").length))).toBe(8);
  });
});

describe("the sample", () => {
  const corpus = Array.from({ length: 60 }, (_, i) =>
    written(i % 3 === 0 ? `short ${i}` : `a much longer message number ${i} which has more than fifteen words so it falls in another length band`, {
      id: i,
      at: i * DAY,
      to: [`r${i % 8}@x.example`],
      isReply: i % 2 === 0,
    }),
  );

  it("is deterministic, whatever the order it's given", () => {
    const limits = SAMPLE_LIMITS.domain;
    const a = chooseSample(corpus, limits).map((m) => m.id);
    const b = chooseSample([...corpus].reverse(), limits).map((m) => m.id);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(limits.maxMessages);
  });

  it("caps each recipient, so one colleague doesn't define you", () => {
    const sample = chooseSample(corpus, SAMPLE_LIMITS.account);
    const per = new Map<string, number>();
    for (const m of sample) per.set(m.to[0]!, (per.get(m.to[0]!) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(3);
  });

  it("covers each band in proportion", () => {
    const sample = chooseSample(corpus, { maxMessages: 12, maxTokens: 6000, perRecipient: 12 });
    const short = sample.filter((m) => m.words < 15).length;
    expect(short).toBeGreaterThanOrEqual(3);
    expect(short).toBeLessThanOrEqual(5);
  });

  it("prefers the newest", () => {
    const sample = chooseSample(corpus, { maxMessages: 6, maxTokens: 6000, perRecipient: 6 });
    expect(Math.min(...sample.map((m) => m.at))).toBeGreaterThanOrEqual(40 * DAY);
  });

  it("holds the token limit", () => {
    const big = Array.from({ length: 10 }, (_, i) => written("word ".repeat(2000) + i, { id: i, at: i, to: [`r${i}@x.example`] }));
    expect(chooseSample(big, { maxMessages: 10, maxTokens: 6000, perRecipient: 3 }).length).toBeLessThanOrEqual(2);
  });

  it("gives a person scope all of its own recent mail: the recipient cap would stop it at 3", () => {
    const one = Array.from({ length: 10 }, (_, i) => written(`message ${i} is here`, { id: i, at: i, to: ["tom@x.example"] }));
    expect(chooseSample(one, SAMPLE_LIMITS.person).length).toBe(10);
  });

  it("picks examples of the same kind first, then the same language, newest first, without duplicates", () => {
    const mails = [
      written("old reply in english and more", { id: 1, at: 1, isReply: true, language: "en" }),
      written("new message started by them", { id: 2, at: 9, isReply: false, language: "en" }),
      written("newer reply in english", { id: 3, at: 5, isReply: true, language: "en" }),
      written("una respuesta en castellano", { id: 4, at: 8, isReply: true, language: "es" }),
      written("newer reply in english", { id: 5, at: 4, isReply: true, language: "en" }),
      written("to a group", { id: 6, at: 7, isReply: true, language: "en", cc: ["b@x.example"] }),
    ];
    expect(chooseExamples(mails, { isReply: true, oneToOne: true, language: "en" }, 3).map((m) => m.id)).toEqual([3, 1, 4]);
  });

  it("the topic check doesn't take a manner note for a subject", () => {
    expect(rejectNote("Leads with the answer, then one short practical reason", [{ text: "the answer is no for a practical reason", to: ["a@x.example"] }, { text: "other mail here", to: ["b@x.example"] }])).toBeNull();
  });

  it("leaves out bulk, the model's own text, empties and duplicates", () => {
    const pool = sampleable([written("x y", { bulk: true }), written("a b", { fromModel: true }), written("", { id: "e" }), written("same", { id: 1 }), written("same", { id: 2 }), written("fine", { id: 3 })]);
    expect(pool.map((m) => m.text).sort()).toEqual(["fine", "same"]);
  });
});

const habits = (over: Partial<Habits> = {}): Habits => ({
  messages: 40,
  words: { median: 30, p80: 80 },
  sentenceWords: 10,
  greetings: [{ text: "Hi {name},", share: 0.8 }],
  noGreeting: 0.2,
  signOffs: [{ text: "Best,\nTom", share: 0.7 }],
  noSignOff: 0.3,
  exclamation: 0.1,
  emoji: 0,
  bullets: 0,
  lowercase: 0,
  languages: [{ text: "en", share: 1 }],
  replies: 0.8,
  oneToOne: 0.9,
  ...over,
});
const profile = (scope: VoiceProfile["scope"], over: Partial<VoiceProfile> = {}): VoiceProfile => ({ scope, key: scope, language: "en", samples: 40, habits: habits(), phrases: [], judgment: null, ...over });
const traits = { formality: 3, warmth: 3, directness: 3, detail: 3, humor: 0 };

describe("level rendering", () => {
  it("renders everything at the top", () => {
    const text = renderLevel(profile("you", { phrases: ["let me know"] }), null);
    expect(text).toContain("length: usually 30 words");
    expect(text).toContain('opens with: "Hi {name}," 80%');
    expect(text).toContain('"Best, / Tom" 70%');
    expect(text).toContain('phrases they reuse: "let me know"');
  });

  it("renders only what differs from the parent", () => {
    const you = profile("you", { phrases: ["let me know"], judgment: { traits, notes: ["Answers first"] } });
    const same = profile("account", { phrases: ["let me know"], judgment: { traits, notes: ["Answers first"] } });
    expect(renderLevel(same, you, ALL_PARTS)).toBe("");
    const different = profile("account", {
      habits: habits({ words: { median: 8, p80: 20 }, greetings: [{ text: "hey {name}", share: 0.9 }], exclamation: 0.5 }),
      phrases: ["let me know", "sounds good to me"],
      judgment: { traits: { ...traits, formality: 1 }, notes: ["Answers first", "Drops pleasantries"] },
    });
    const text = renderLevel(different, you, ALL_PARTS);
    expect(text).toContain("length: usually 8 words");
    expect(text).toContain('opens with: "hey {name}" 90%');
    expect(text).toContain("exclamation marks: present in 50%");
    expect(text).toContain('phrases they reuse: "sounds good to me"');
    expect(text).not.toContain('"let me know"');
    expect(text).toContain("manner: formality 1/5");
    expect(text).not.toContain("warmth");
    expect(text).toContain("note: Drops pleasantries");
    expect(text).not.toContain("Answers first");
  });

  it("ignores differences too small to mean anything", () => {
    expect(renderHabits(habits({ words: { median: 3, p80: 80 }, exclamation: 0.15 }), habits({ words: { median: 5, p80: 80 } }))).toEqual([]);
  });

  it("chains each level against the one above and skips one with nothing to add", () => {
    const you = profile("you");
    const account = profile("account");
    const person = profile("person", { habits: habits({ words: { median: 6, p80: 12 } }) });
    expect(renderVoices([you, account, person]).map((v) => v.scope)).toEqual(["you", "person"]);
  });

  it("renders a person from another account whole, and labels it", () => {
    const you = profile("you");
    const person = profile("person", { fromOtherAccount: true });
    const [, rendered] = renderVoices([you, person]);
    expect(rendered).toMatchObject({ scope: "person", fromOtherAccount: true });
    expect(rendered!.text).toContain("length: usually 30 words");
  });

  it("handles someone new: you, account and their domain", () => {
    const chain = [profile("you"), profile("account", { habits: habits({ exclamation: 0.8 }) }), profile("domain", { habits: habits({ exclamation: 0.8, words: { median: 90, p80: 200 } }) })];
    expect(renderVoices(chain).map((v) => v.scope)).toEqual(["you", "account", "domain"]);
  });

  it("leaves parts out on request, the eval's arms", () => {
    const you = profile("you", { phrases: ["let me know"], judgment: { traits, notes: ["Answers first"] } });
    const text = renderLevel(you, null, { habits: false, phrases: true, traits: false, notes: false });
    expect(text).toContain("let me know");
    expect(text).not.toContain("Answers first");
    expect(text).not.toContain("length:");
  });

  it("sends only the local parts by default, whatever the profile holds", () => {
    const you = profile("you", { judgment: { traits, notes: ["Answers first"] } });
    expect(renderVoices([you])[0]!.text).not.toContain("Answers first");
    expect(renderVoices([you])[0]!.text).not.toContain("manner:");
    expect(renderVoices([you], ALL_PARTS)[0]!.text).toContain("Answers first");
  });
});

describe("budgets", () => {
  const parts = (over: Partial<DraftParts> = {}): DraftParts => ({
    fixedTokens: 500,
    inbound: "inbound text",
    voiceGeneral: ["general voice"],
    voiceSpecific: ["specific voice"],
    thread: [{ from: "a", date: "2026-01-01", own: false, text: "earlier", snippet: "earl" }],
    messagesToPerson: ["m1", "m2", "m3", "m4", "m5"],
    pastConversations: ["p1", "p2"],
    ...over,
  });
  const large = { capacityTokens: 200_000, outputTokens: 8000 };

  it("keeps everything when there's room, 4 messages at most", () => {
    const fitted = fitDraftBudget(parts(), large);
    expect(fitted.inbound).toBe("inbound text");
    expect(fitted.voiceGeneral).toHaveLength(1);
    expect(fitted.voiceSpecific).toHaveLength(1);
    expect(fitted.messagesToPerson).toHaveLength(4);
    expect(fitted.pastConversations).toHaveLength(2);
  });

  it("refuses when the part that's never cut doesn't fit, and says how much", () => {
    expect(() => fitDraftBudget(parts({ fixedTokens: 5000 }), { capacityTokens: 4096, outputTokens: 1000 })).toThrow(DraftTooLargeError);
  });

  it("keeps a margin on the estimate and reserves output first", () => {
    expect(fitDraftBudget(parts(), { capacityTokens: 10_000, outputTokens: 2000, framingTokens: 0 }).budget).toBe(6400);
  });

  it("cuts from the bottom of the order", () => {
    const pad = (tokens: number) => "x".repeat(tokens * 4);
    // room for fixed, inbound and general voice; nothing below
    const fitted = fitDraftBudget(parts({ inbound: pad(500), voiceGeneral: [pad(500)], voiceSpecific: [pad(700)], messagesToPerson: [pad(500), pad(500)], pastConversations: [pad(700)] }), { capacityTokens: 2500 + 1000 + 200, outputTokens: 1000, framingTokens: 0 });
    expect(fitted.inbound).toHaveLength(2000);
    expect(fitted.voiceGeneral).toHaveLength(1);
    expect(fitted.voiceSpecific).toHaveLength(0);
    expect(fitted.messagesToPerson).toEqual([]);
    expect(fitted.pastConversations).toEqual([]);
  });

  it("drops messages to the person from 4 to 2, then all", () => {
    const pad = "x".repeat(400);
    const at = (room: number) => fitDraftBudget(parts({ fixedTokens: 0, inbound: null, voiceGeneral: [], voiceSpecific: [], thread: [], messagesToPerson: [pad, pad, pad, pad], pastConversations: [] }), { capacityTokens: room, outputTokens: 0, framingTokens: 0 }).messagesToPerson.length;
    expect(at(600)).toBe(4);
    expect(at(400)).toBe(3);
    expect(at(280)).toBe(2);
    expect(at(150)).toBe(0);
  });

  it("clips thread messages, the user's own at 400 tokens and others at 300", () => {
    const long = "y".repeat(10_000);
    const fitted = fitDraftBudget(parts({ thread: [{ from: "me", date: "d", own: true, text: long, snippet: "s" }, { from: "a", date: "d", own: false, text: long, snippet: "s" }] }), large);
    expect(fitted.thread[0]!.text.length).toBeLessThanOrEqual(1600);
    expect(fitted.thread[1]!.text.length).toBeLessThanOrEqual(1200);
  });

  it("past the 20 newest, a thread message is its snippet", () => {
    const thread = Array.from({ length: 25 }, (_, i) => ({ from: "a", date: `d${i}`, own: false, text: `full text ${i}`, snippet: `snip ${i}` }));
    const fitted = fitDraftBudget(parts({ thread }), large);
    expect(fitted.thread).toHaveLength(25);
    expect(fitted.thread[0]!.text).toBe("snip 0");
    expect(fitted.thread[24]!.text).toBe("full text 24");
  });

  it("holds the budget on a huge inbound message, keeping both ends", () => {
    const inbound = `HEAD${"z".repeat(100_000)}TAIL`;
    const fitted = fitDraftBudget(parts({ inbound, fixedTokens: 0 }), { capacityTokens: 4096, outputTokens: 1000, framingTokens: 0 });
    expect(fitted.inbound!.startsWith("HEAD")).toBe(true);
    expect(fitted.inbound!.endsWith("TAIL")).toBe(true);
    expect(fitted.used).toBeLessThanOrEqual(fitted.budget);
    expect(headAndTail("short", 100)).toBe("short");
  });

  it("the draft's words survive every cut, as they're in the part never cut", () => {
    const fitted = fitDraftBudget(parts({ fixedTokens: 2400, inbound: "x".repeat(40_000) }), { capacityTokens: 4096, outputTokens: 1000, framingTokens: 0 });
    expect(fitted.budget).toBeGreaterThanOrEqual(2400);
  });
});

describe("resolveIntent", () => {
  const tom: IntentPerson = { name: "Tom Reed", address: "tom@acme.example" };
  const ana: IntentPerson = { name: "Ana Ruiz", address: "ana@acme.example" };
  const mark: IntentPerson = { name: "Mark Lee", address: "mark@acme.example" };
  const people = [tom, ana, mark];
  const ready = (token: string): ContactLookup => ({ state: "ready", hits: people.filter((p) => p.name.toLowerCase().split(" ").includes(token)) });
  const thread = { kind: "thread" as const, participants: [tom, ana], lastSender: "ana@acme.example" };

  it("takes an address as it is, with no call", () => {
    expect(resolveIntent({ instruction: "write to zed@new.example saying hello", surface: { kind: "list" }, lookup: ready })).toEqual({ kind: "route", route: { type: "new", to: { name: "", address: "zed@new.example" } } });
  });

  it.each([["tell tom this is fine"], ["dile a Tom que está bien"], ["tom: fine"], ["TELL TÓM ok"]])("finds a participant in %s, and confirms before changing the route", (instruction) => {
    expect(resolveIntent({ instruction, surface: thread, lookup: ready })).toEqual({ kind: "confirm", candidates: [tom] });
  });

  it("a participant who'd get the reply anyway needs no call", () => {
    expect(resolveIntent({ instruction: "tell ana it's fine", surface: thread, lookup: ready })).toMatchObject({ kind: "route", route: { type: "reply", to: ana } });
  });

  it("'Mark the invoice as paid' doesn't address Mark", () => {
    const decision = resolveIntent({ instruction: "Mark the invoice as paid", surface: { kind: "thread", participants: [mark, ana], lastSender: "ana@acme.example" }, lookup: ready });
    expect(decision).toEqual({ kind: "confirm", candidates: [mark] });
    expect(resolveIntent({ instruction: "Mark the invoice as paid", surface: { kind: "thread", participants: [mark, ana], lastSender: "ana@acme.example" }, lookup: ready, confirmed: null })).toMatchObject({ kind: "route", route: { type: "reply", to: null, answering: "ana@acme.example" } });
  });

  it("a thread with a participant confirmed: replies to them alone, everyone a click away", () => {
    expect(resolveIntent({ instruction: "tell tom", surface: thread, lookup: ready, confirmed: tom.address })).toEqual({ kind: "route", route: { type: "reply", to: tom, answering: tom.address, includeEveryone: 2 } });
  });

  it("a thread with someone else: asks forward or new, never a default", () => {
    expect(resolveIntent({ instruction: "tell mark", surface: thread, lookup: ready, confirmed: mark.address })).toMatchObject({ kind: "ask", question: { type: "forward-or-new", to: { address: mark.address } } });
  });

  it("the list with a recent thread: asks, since it isn't evidence", () => {
    const recentThread = () => ({ threadId: 9, subject: "Quote" });
    expect(resolveIntent({ instruction: "tell tom", surface: { kind: "list" }, lookup: ready, recentThread, confirmed: tom.address })).toEqual({ kind: "ask", question: { type: "new-or-reply", to: { name: "", address: tom.address }, thread: { threadId: 9, subject: "Quote" } } });
  });

  it("the list with no recent thread: a new message", () => {
    expect(resolveIntent({ instruction: "tell tom", surface: { kind: "list" }, lookup: ready, recentThread: () => null, confirmed: tom.address })).toMatchObject({ kind: "route", route: { type: "new" } });
  });

  it("a thread with nobody named: replies as usual, with no call", () => {
    expect(resolveIntent({ instruction: "say it works", surface: thread, lookup: ready })).toMatchObject({ kind: "route", route: { type: "reply", to: null, answering: "ana@acme.example" } });
  });

  it("the list with nobody named: asks who", () => {
    expect(resolveIntent({ instruction: "say it works", surface: { kind: "list" }, lookup: ready })).toEqual({ kind: "ask", question: { type: "who" } });
  });

  it("a draft is never re-addressed", () => {
    const surface = { kind: "draft" as const, recipients: [tom] };
    expect(resolveIntent({ instruction: "tell tom it's fine", surface, lookup: ready })).toEqual({ kind: "route", route: { type: "keep-draft" } });
    expect(resolveIntent({ instruction: "tell ana it's fine", surface, lookup: ready })).toEqual({ kind: "confirm", candidates: [ana] });
    expect(resolveIntent({ instruction: "tell ana it's fine", surface, lookup: ready, confirmed: ana.address })).toMatchObject({ kind: "ask", question: { type: "add-or-just-write" } });
    expect(resolveIntent({ instruction: "say hello", surface, lookup: ready })).toEqual({ kind: "route", route: { type: "keep-draft" } });
  });

  it("a draft with nobody on it takes the person", () => {
    expect(resolveIntent({ instruction: "tell tom", surface: { kind: "draft", recipients: [] }, lookup: ready, confirmed: tom.address })).toMatchObject({ kind: "route", route: { type: "fill-draft" } });
  });

  it("a cold index says so and waits, rather than reading it as nobody", () => {
    const cold = (): ContactLookup => ({ state: "cold", hits: [] });
    expect(resolveIntent({ instruction: "tell tom", surface: { kind: "list" }, lookup: cold })).toMatchObject({ kind: "wait", tokens: expect.arrayContaining(["tom"]) });
  });

  it("a cold index doesn't hold up a participant it already knows", () => {
    const cold = (): ContactLookup => ({ state: "cold", hits: [] });
    expect(resolveIntent({ instruction: "tell tom", surface: thread, lookup: cold })).toEqual({ kind: "confirm", candidates: [tom] });
  });

  it("two people of one name both go to the model", () => {
    const other = { name: "Tom Vance", address: "tvance@x.example" };
    const lookup = (t: string): ContactLookup => ({ state: "ready", hits: t === "tom" ? [tom, other] : [] });
    expect(resolveIntent({ instruction: "tell tom", surface: { kind: "list" }, lookup })).toEqual({ kind: "confirm", candidates: [tom, other] });
  });
});

describe("checkSpecifics", () => {
  const sources = (...texts: string[]) => ({ texts, today: "2026-03-05" });

  it("flags an invented date, amount and URL", () => {
    const found = checkSpecifics("We can sign on 19 March for $4,500. Details at https://evil.example/a and ana@evil.example.", sources("We'll sign soon."));
    expect(found).toEqual(expect.arrayContaining([{ kind: "date", text: "19 March" }, { kind: "amount", text: "$4,500" }, { kind: "url", text: "https://evil.example/a" }, { kind: "address", text: "ana@evil.example" }]));
  });

  it("doesn't flag what the sources authorize, in any spelling", () => {
    const found = checkSpecifics("See you March 19 at 3:30, it's 4,200 euros. https://acme.example/a. tom@acme.example", sources("On 19 de marzo, a las 3:30. 4.200 EUR.", "www.acme.example/a/", "Tom <tom@acme.example>"));
    expect(found).toEqual([]);
  });

  it("flags a date whose day appears elsewhere as a number", () => {
    expect(checkSpecifics("Let's do 19 March.", sources("Invoice 19 is paid."))).toEqual([{ kind: "date", text: "19 March" }]);
  });

  it("flags a bare number and an invented weekday, not one the sources mention", () => {
    expect(checkSpecifics("Give me 12 days, until Friday.", sources("soon"))).toEqual(expect.arrayContaining([{ kind: "number", text: "12" }, { kind: "date", text: "Friday" }]));
    expect(checkSpecifics("Friday works.", sources("Can you do viernes?"))).toEqual([]);
    expect(checkSpecifics("El viernes me va bien.", sources("Friday?"))).toEqual([]);
  });

  it("allows dates derived from today", () => {
    expect(checkSpecifics("Today, the 5th, or March 6 works.", sources("Can you do tomorrow?"))).toEqual([]);
    // 2026-03-05 is a Thursday
    expect(checkSpecifics("Thursday is fine.", sources("hello"))).toEqual([]);
    expect(checkSpecifics("Friday is fine.", sources("Can you do tomorrow?"))).toEqual([]);
  });

  it("leaves placeholders and list marks alone, and rewrites nothing", () => {
    const draft = "1. Sign by [date of 12]\n2. Done";
    expect(checkSpecifics(draft, sources("x"))).toEqual([]);
    expect(findPlaceholders(draft)).toEqual(["[date of 12]"]);
  });

  it("comes up empty on an ordinary draft", () => {
    expect(checkSpecifics("Thanks, that works for me. Let me know if anything changes.", sources("Is it ok?"))).toEqual([]);
  });
});

describe("the note screen", () => {
  const sample = [
    { text: "the biopsy came back clean, dont tell anyone at work please", to: ["joss@x.example"] },
    { text: "the chemotherapy of my sister starts on monday, keep it quiet", to: ["joss@x.example"] },
    { text: "la quimioterapia de mi hermana empieza el lunes", to: ["joss@x.example"] },
    { text: "sounds good, ship it when ready", to: ["dana@y.example"] },
    { text: "sounds good, thanks for the quick reply", to: ["sam@y.example"] },
  ];

  it("rejects digits, addresses and URLs", () => {
    expect(rejectNote("Replies within 2 hours", sample)).toBe("digits");
    expect(rejectNote("Copies ana@acme.example often", sample)).toBe("address");
    expect(rejectNote("Links to acme.com", sample)).toBe("url");
  });

  it("rejects four copied words, and more than 14 words", () => {
    expect(rejectNote("says dont tell anyone at work when asked", sample)).toBe("copied");
    expect(rejectNote("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", sample)).toBe("too-long");
  });

  it("semantic canaries: catches a word that only came up with one recipient, in lowercase and in other languages", () => {
    expect(rejectNote("writes gently about the biopsy", sample)).toBe("topic");
    expect(rejectNote("escribe con cuidado sobre la quimioterapia", sample)).toBe("topic");
    expect(rejectNote("mentions her sister often", sample)).toBe("topic");
  });

  it("semantic canaries: a paraphrase gets through, which is why the eval measures it and notes stay editable", () => {
    expect(rejectNote("writes warmly about a relative's cancer treatment", sample)).toBeNull();
  });

  it("passes manner", () => {
    expect(rejectNote("Answers first, explains only if asked", sample)).toBeNull();
    expect(rejectNote("Drops pleasantries, moves straight to the point", sample)).toBeNull();
  });

  it("keeps four at most and says why the rest went", () => {
    const { kept, rejected } = screenNotes(["a b", "c d", "e f", "g h", "i j", "has 1 digit"], sample);
    expect(kept).toHaveLength(4);
    expect(rejected).toEqual([{ note: "has 1 digit", reason: "digits" }]);
  });
});
