import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { SentText } from "../autocomplete-source";
import { SliceClock } from "../instant/slices";
import { detectLanguage, ownText, PhraseModel, tokenize } from "./phrases";

let id = 1;
const to = (name: string): Address[] => [{ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@x.io` }];
const msg = (text: string, recipient = "Arjun Patel", fromName = "Luis Cordero"): SentText => ({ id: id++, accountId: 1, date: 0, fromName, to: to(recipient), text });
const clock = () => new SliceClock({});

function trained(texts: (string | SentText)[], model = new PhraseModel()): PhraseModel {
  for (const t of texts) model.learn(typeof t === "string" ? msg(t) : t);
  return model;
}

describe("own text", () => {
  it("cuts quotes, attributions, forwards and signatures", () => {
    expect(ownText("Sounds good.\n\nOn Tue, 3 Mar 2026 at 10:00, Ana <ana@x.io> wrote:\n> the quote")).toBe("Sounds good.\n");
    expect(ownText("Perfecto.\n\nEl 3 mar 2026, Ana escribió:\n> cita")).toBe("Perfecto.\n");
    expect(ownText("FYI\n\n---------- Forwarded message ----------\nFrom: Ana <ana@x.io>\nDate: today\n\nreceived text")).toBe("FYI\n");
    expect(ownText("Mira esto\n\n---------- Mensaje reenviado ----------\nDe: Ana <ana@x.io>\nFecha: hoy\n\ntexto recibido")).toBe("Mira esto\n");
    expect(ownText("Thanks!\n\n-- \nLuis Cordero\nAcme")).toBe("Thanks!\n");
    expect(ownText("Ok\n\n-----Original Message-----\nFrom: x")).toBe("Ok\n");
    expect(ownText("Hi\n> quoted line\nmine")).toBe("Hi\nmine");
    expect(ownText("x".repeat(20_000)).length).toBe(4096);
  });

  it("tokenizes words, numbers and punctuation", () => {
    expect(tokenize("Hi Ana, let's meet at 3:30 — ok? Thanks!")).toEqual(["Hi", "Ana", ",", "let's", "meet", "at", "3:30", "ok", "?", "Thanks", "!"]);
    expect(tokenize("¿Podrías revisarlo?")).toEqual(["Podrías", "revisarlo", "?"]);
  });

  it("detects English, Spanish, or neither", () => {
    expect(detectLanguage("Thanks for the update, I will have it ready")).toBe(1);
    expect(detectLanguage("Gracias por la información, nos vemos el lunes")).toBe(2);
    expect(detectLanguage("ok")).toBe(0);
  });
});

describe("suggestions", () => {
  const corpus = [
    "Let me know if you have any questions.",
    "Thanks, let me know if you have any questions.",
    "Please let me know if you have any questions.",
    "Let me know if you have any questions about it.",
    "I hope you're doing well.",
    "I hope you're doing well.",
    "I hope you're doing well.",
  ];

  it("completes a phrase the user keeps writing, from the next word or mid-word", () => {
    const m = trained([...corpus, ...corpus]);
    expect(m.suggest({ before: "Let me know if" })).toBe(" you have any questions.");
    expect(m.suggest({ before: "Let me know if you h" })).toBe("ave any questions.");
    expect(m.suggest({ before: "Great news. I hope you" })).toBe("'re doing well.");
    expect(m.suggest({ before: "something\nlet me know if you " })).toBe("have any questions.");
  });

  it("stays quiet for text it hasn't seen or isn't sure about", () => {
    const m = trained([...corpus, ...corpus]);
    expect(m.suggest({ before: "The quarterly numbers" })).toBeNull();
    expect(m.suggest({ before: "" })).toBeNull();
    expect(m.suggest({ before: "Let me know if you have any questions. " })).toBeNull();
    // once is not a habit
    expect(trained(["Our offsite is in Lisbon this year."]).suggest({ before: "Our offsite is" })).toBeNull();
  });

  it("many one-off continuations never look like a habit (Space-Saving's inherited counts aren't trusted)", () => {
    const m = new PhraseModel();
    // the same context, followed by 40 different words once each
    for (let i = 0; i < 40; i++) m.learn(msg(`We should meet word${i} tomorrow.`));
    expect(m.suggest({ before: "We should meet " })).toBeNull();
    expect(m.suggest({ before: "We should meet wor" })).toBeNull();
  });

  it("greetings learn the recipient's name and fill in the draft's", () => {
    const m = trained([msg("Hi Arjun,\nSee you soon.", "Arjun Patel"), msg("Hi Laura,\nSee you soon.", "Laura Gómez"), msg("Hi Ana,\nThanks.", "Ana Ruiz"), msg("Hi Sam,\nok", "Sam Lee")]);
    expect(m.suggest({ before: "Hi ", names: ["Beatriz Núñez"] })).toBe("Beatriz,");
    expect(m.suggest({ before: "Hi B", names: ["Beatriz Núñez"] })).toBe("eatriz,");
    // no recipient yet: nothing to fill in
    expect(m.suggest({ before: "Hi " })).toBeNull();
  });

  it("sign-offs learn the sender's own name", () => {
    const texts = [1, 2, 3, 4].map(() => msg("Sounds good.\n\nBest,\nLuis", "Ana Ruiz", "Luis Cordero"));
    const m = trained(texts);
    expect(m.suggest({ before: "Done.\n\nBe", me: "Luis Cordero" })).toBe("st,");
    // a lone comma isn't worth a suggestion
    expect(m.suggest({ before: "Done.\n\nBest", me: "Luis Cordero" })).toBeNull();
  });

  it("keeps languages apart at the start of a sentence", () => {
    const en = [1, 2, 3, 4].map(() => msg("Thanks for the quick reply, it is very helpful for the team."));
    const es = [1, 2, 3, 4].map(() => msg("Gracias por la respuesta, nos vemos el lunes para la reunión."));
    const m = trained([...en, ...es]);
    expect(m.suggest({ before: "Hola Ana, la propuesta está lista para el equipo.\nGra" })).toBe("cias por la respuesta,");
    expect(m.suggest({ before: "The proposal is ready for the team, and the plan too.\nTha" })).toBe("nks for the quick reply,");
  });

  it("learns each message once, and never from quoted mail", () => {
    const m = new PhraseModel();
    const once = msg("Let me know if you have any questions.");
    for (let i = 0; i < 10; i++) m.learn(once);
    expect(m.suggest({ before: "Let me know if" })).toBeNull();
    for (let i = 0; i < 5; i++) m.learn(msg(`ok\n\nOn Mon, Ana wrote:\n> The invoice is attached below for your records.`));
    expect(m.suggest({ before: "The invoice is" })).toBeNull();
  });

  it("only the end of a huge 'before' is read", () => {
    const m = trained([...corpus, ...corpus]);
    const huge = `${"lorem ipsum dolor sit amet ".repeat(400_000)}\nLet me know if`;
    const t0 = performance.now();
    expect(m.suggest({ before: huge })).toBe(" you have any questions.");
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("a full table is pruned in place: frequent phrases survive, memory doesn't grow", async () => {
    const m = new PhraseModel({ slots: 1 << 14, words: 60_000 });
    const before = m.allocatedBytes();
    for (let i = 0; i < 6; i++) m.learn(msg("Let me know if you have any questions."));
    let pruned = 0;
    for (let i = 0; i < 3000; i++) {
      m.learn(msg(`unique${i} filler${i} words${i} here${i}.`));
      if (m.needsPrune()) {
        await m.prune(clock());
        pruned++;
      }
      if (i % 100 === 0) m.learn(msg("Let me know if you have any questions."));
    }
    expect(pruned).toBeGreaterThan(0);
    expect(m.suggest({ before: "Let me know if" })).toBe(" you have any questions.");
    // the table is fixed; only the vocabulary grew (bounded by its own cap)
    expect(m.allocatedBytes() - before).toBeLessThan(3000 * 4 * 200);
  });

  it("the vocabulary's bytes are capped, not just its count: long tokens aren't kept (codex review)", () => {
    const m = new PhraseModel({ slots: 1 << 12, words: 60_000 });
    const before = m.allocatedBytes();
    for (let i = 0; i < 3000; i++) m.learn(msg(`${"x".repeat(4000)}${i} and ${"é".repeat(3000)}${i}`));
    expect(m.allocatedBytes() - before).toBeLessThan(1024 * 1024);
    const big = new PhraseModel({ slots: 1 << 12, words: 60_000 });
    for (let i = 0; i < 200_000; i++) big.learn(msg(`w${i}abcdefghijklmnopqrstu`));
    expect((big as unknown as { wordChars: number }).wordChars).toBeLessThanOrEqual(1_000_000);
  });

  it("a snapshot over today's vocabulary limits is refused (codex review, round 2)", async () => {
    const m = trained(["Let me know if you have any questions."]);
    // as an older version could have written it: a 4,000-character "word"
    (m as unknown as { words: string[] }).words.push("x".repeat(4000));
    for (const k of ["lower", "cap", "upper", "other"]) (m as unknown as Record<string, Uint32Array>)[k] = new Uint32Array(64);
    m.revision = { epoch: "e", seq: 1 };
    const bytes = await m.snapshot("t", clock());
    expect(await new PhraseModel().restore(bytes, "t", clock())).toBe(false);
  });

  it("the vocabulary is capped", () => {
    const m = new PhraseModel({ slots: 1 << 12, words: 100 });
    for (let i = 0; i < 500; i++) m.learn(msg(`word${i} word${i + 1}`));
    expect((m as unknown as { words: string[] }).words.length).toBeLessThanOrEqual(105);
  });

  it("a snapshot restores the same suggestions; foreign and damaged ones are refused", async () => {
    const m = trained([...corpus, ...corpus, msg("Hi Arjun,\nok"), msg("Hi Laura,\nok", "Laura G"), msg("Hi Ana,\nok", "Ana R"), msg("Hi Sam,\nok", "Sam L")]);
    m.revision = { epoch: "e", seq: 3 };
    const bytes = await m.snapshot("t", clock());
    const r = new PhraseModel();
    expect(await r.restore(bytes, "t", clock())).toBe(true);
    for (const before of ["Let me know if", "I hope you", "Let me know if you h"]) expect(r.suggest({ before })).toBe(m.suggest({ before }));
    expect(r.suggest({ before: "Hi ", names: ["Zoe"] })).toBe("Zoe,");
    expect(r.hasLearned(1)).toBe(m.hasLearned(1));
    expect(await new PhraseModel().restore(bytes, "other", clock())).toBe(false);
    expect(await new PhraseModel({ slots: 1 << 17, words: 60_000 }).restore(bytes, "t", clock())).toBe(false);
    const bad = bytes.slice();
    bad[bad.length - 5]! ^= 0x55;
    expect(await new PhraseModel().restore(bad, "t", clock())).toBe(false);
  });
});
