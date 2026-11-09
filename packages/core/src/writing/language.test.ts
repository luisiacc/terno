import { describe, expect, it } from "vitest";
import { chooseLanguage, detectWritingLanguage, languageName, namedLanguage, questionLanguage, voiceForLanguage, type LanguageEvidence } from "./language";
import type { VoiceProfile } from "./types";

const none: LanguageEvidence = { instruction: "", threadOwn: [], inbound: "", toPerson: [] };
const shares = (text: string, share = 0.9) => ({ languages: [{ text, share }] });

describe("detectWritingLanguage", () => {
  it.each([
    ["Thanks for the update, please send it to me and we will have a look.", "en"],
    ["Hola, gracias por el correo. Te escribo para que me digas cómo va todo.", "es"],
    ["Bonjour, merci pour votre message. Nous pouvons nous voir dans la semaine avec plaisir.", "fr"],
    ["Olá, obrigado pela mensagem. Você pode enviar para mim? Não tenho a versão em português.", "pt"],
    ["Hallo, danke für die Nachricht. Ich bin nicht sicher, aber wir haben das mit ihr besprochen.", "de"],
    ["Ciao, grazie per il messaggio. Non sono sicuro, ma ho anche parlato con il tuo collega.", "it"],
    ["Hallo, bedankt voor het bericht. Ik ben niet zeker, maar we zijn er mee bezig.", "nl"],
    ["お世話になっております。ご連絡ありがとうございます。", "ja"],
    ["안녕하세요. 메일 감사합니다.", "ko"],
    ["您好，感谢您的来信，我们明天再谈。", "zh"],
    ["Здравствуйте, спасибо за письмо. Давайте поговорим завтра.", "ru"],
  ])("%s", (text, language) => {
    expect(detectWritingLanguage(text)).toBe(language);
  });

  it("reads short mail when it has enough to go on", () => {
    expect(detectWritingLanguage("Hi Claire, yes, Thursday works.")).toBe("en");
    expect(detectWritingLanguage("Hola Claire, sí, el jueves está bien.")).toBe("es");
    expect(detectWritingLanguage("Bonjour Claire, oui, merci.")).toBe("fr");
  });

  it("doesn't guess on short mail", () => {
    for (const text of ["ok", "Gracias!", "thanks", "👍", "", "12:30"]) expect(detectWritingLanguage(text)).toBe("");
  });

  it("abstains on shared words rather than guess between languages", () => {
    expect(detectWritingLanguage("Por favor, me avise no final de semana.")).toBe("");
    expect(detectWritingLanguage("Meeting in London, dinner in Soho?")).toBe("");
  });

  it("a name in another script doesn't change an English mail", () => {
    expect(detectWritingLanguage("Please thank 田中 for the update and tell him we will have it with the others.")).toBe("en");
  });
});

describe("questionLanguage", () => {
  it.each([
    ["What did Isabella say about the payment?", "en"],
    ["When is my flight?", "en"],
    ["How much did I spend on Uber last month?", "en"],
    ["Who sent the contract?", "en"],
    ["¿Qué dijo Isabella sobre el pago?", "es"],
    ["Qué dijo Isabella sobre el pago", "es"],
    ["cuándo es mi vuelo", "es"],
    ["¿Cuánto gasté en Uber el mes pasado?", "es"],
    ["Quién mandó el contrato", "es"],
    ["Bonjour, quand est-ce que nous avons la réunion avec vous?", "fr"],
  ])("%s", (question, language) => {
    expect(questionLanguage(question)).toBe(language);
  });

  it("goes by how it asks when it's mixed", () => {
    expect(questionLanguage("What did Isabella say about the pago de la factura?")).toBe("en");
    expect(questionLanguage("¿Qué dijo Isabella about the invoice?")).toBe("es");
    // a name with an accent is a name
    expect(questionLanguage("What did José say?")).toBe("en");
  });

  it("plain questions that open with a verb (Codex review)", () => {
    expect(questionLanguage("Has Alice replied?")).toBe("en");
    expect(questionLanguage("Did Ana pay?")).toBe("en");
    expect(questionLanguage("Puedes decirme si pagaron?")).toBe("es");
    expect(questionLanguage("Ya pagó Ana?")).toBe("es");
  });

  it("the mail's words unquoted don't outweigh how the question asks (Codex review)", () => {
    expect(questionLanguage("When is el pago de la factura?")).toBe("en");
    expect(questionLanguage("Is there anything from Ana sobre el contrato de la casa?")).toBe("en");
    expect(questionLanguage("Qué dijo Ana about the payment of the invoice?")).toBe("es");
  });

  it("the mail's words in quotes don't count", () => {
    expect(questionLanguage("When is “la cena de gala de la empresa”?")).toBe("en");
    expect(questionLanguage('Where is "el contrato de la casa"?')).toBe("en");
    expect(questionLanguage("Who's 'el señor de la tienda'?")).toBe("en");
  });

  it("says nothing when the question doesn't say", () => {
    for (const question of ["", "Isabella?", "Uber 2026", "👍", "Acme invoice", "María?", "Peña?", "José Ramírez"]) expect(questionLanguage(question)).toBe("");
  });

  it("short questions that do say", () => {
    expect(questionLanguage("and when?")).toBe("en");
    expect(questionLanguage("y cuándo?")).toBe("es");
    expect(questionLanguage("¿y Juan?")).toBe("es");
    expect(questionLanguage("What?")).toBe("en");
  });
});

describe("namedLanguage", () => {
  it.each([
    ["say yes, in Spanish", "es"],
    ["dile que sí en inglés", "en"],
    ["réponds en français", "fr"],
    ["antworte auf Deutsch", "de"],
    ["responde em português", "pt"],
    ["Write in Spanish, not in English", "es"],
    ["Not in Spanish; answer in French", "fr"],
    ["no en inglés, en español", "es"],
    ["write it in English and in Spanish", null],
    ["say no politely", null],
    ["he lives in France", null],
  ])("%s", (instruction, language) => {
    expect(namedLanguage(instruction)).toBe(language);
  });
});

describe("chooseLanguage: any combination of accounts and people", () => {
  it("does what the person asks, above everything", () => {
    expect(chooseLanguage({ ...none, instruction: "say yes in French", threadOwn: ["es"], inbound: "en", toPerson: ["es", "es", "es"] })).toEqual({ language: "fr", reason: "asked" });
  });

  it("keeps to what the author already writes in this conversation", () => {
    expect(chooseLanguage({ ...none, threadOwn: ["es", "en"], inbound: "en", toPerson: ["en", "en", "en"] })).toEqual({ language: "es", reason: "thread" });
  });

  it("keeps a settled habit with this person even when they write in another language", () => {
    expect(chooseLanguage({ ...none, inbound: "en", toPerson: ["es", "es", "es", "en"] })).toEqual({ language: "es", reason: "person" });
  });

  it("follows the other person when the history with them is mixed", () => {
    expect(chooseLanguage({ ...none, inbound: "en", toPerson: ["es", "en", "es", "en"] })).toEqual({ language: "en", reason: "inbound" });
  });

  it("follows the other person when a little history isn't a habit yet", () => {
    expect(chooseLanguage({ ...none, inbound: "en", toPerson: ["es", "es"] })).toEqual({ language: "en", reason: "inbound" });
  });

  it("a habit is what they do now, not years ago", () => {
    const moved = [...Array(12).fill("en"), ...Array(40).fill("es")];
    expect(chooseLanguage({ ...none, inbound: "es", toPerson: moved })).toEqual({ language: "en", reason: "person" });
  });

  it("a new message to someone written to once goes in that language", () => {
    expect(chooseLanguage({ ...none, toPerson: ["fr"], account: shares("en") })).toEqual({ language: "fr", reason: "person" });
  });

  it("the same person from another account comes before this account's own habit", () => {
    expect(chooseLanguage({ ...none, otherAccount: shares("es"), account: shares("en") })).toEqual({ language: "es", reason: "otherAccount" });
  });

  it("someone new at a known domain follows how this account writes to that domain", () => {
    expect(chooseLanguage({ ...none, domain: shares("de"), account: shares("en"), you: shares("es") })).toEqual({ language: "de", reason: "domain" });
  });

  it("someone new follows this account, whatever the others do", () => {
    expect(chooseLanguage({ ...none, account: shares("es"), you: shares("en") })).toEqual({ language: "es", reason: "account" });
    expect(chooseLanguage({ ...none, account: shares("en"), you: shares("es") })).toEqual({ language: "en", reason: "account" });
  });

  it("then how they write in general, then the instruction's language", () => {
    expect(chooseLanguage({ ...none, you: shares("pt") })).toEqual({ language: "pt", reason: "you" });
    expect(chooseLanguage({ ...none, instruction: "dile que el martes no puedo ir a la reunión" })).toEqual({ language: "es", reason: "instruction" });
  });

  it("an evenly split level doesn't decide", () => {
    expect(chooseLanguage({ ...none, account: { languages: [{ text: "en", share: 0.4 }, { text: "es", share: 0.4 }] }, you: shares("fr") })).toEqual({ language: "fr", reason: "you" });
  });

  it("says when it can't tell, and the prompt's own rule decides", () => {
    expect(chooseLanguage(none)).toEqual({ language: "", reason: "unknown" });
    expect(chooseLanguage({ ...none, instruction: "ok" })).toEqual({ language: "", reason: "unknown" });
  });

  it("the instruction's language doesn't set a reply's", () => {
    expect(chooseLanguage({ ...none, instruction: "dile que el martes no puedo ir", inbound: "en" })).toEqual({ language: "en", reason: "inbound" });
  });
});

describe("voiceForLanguage", () => {
  const profile = (language: string, top: string): VoiceProfile => ({
    scope: "person",
    key: "person:1:tom@x.example",
    language,
    samples: 9,
    phrases: ["sounds good to me"],
    judgment: null,
    habits: { messages: 9, words: { median: 20, p80: 40 }, sentenceWords: 9, greetings: [{ text: "Hi {name},", share: 0.9 }], noGreeting: 0.1, signOffs: [{ text: "Best", share: 0.8 }], noSignOff: 0.2, exclamation: 0.5, emoji: 0, bullets: 0, lowercase: 0, languages: [{ text: top, share: 1 }], replies: 1, oneToOne: 1 },
  });

  it("leaves greetings and phrases in the language they're written in", () => {
    const fits = voiceForLanguage(profile("", "en"), "en");
    expect(fits.habits.greetings[0]!.text).toBe("Hi {name},");
    expect(fits.phrases).toEqual(["sounds good to me"]);
  });

  it("keeps another language's greeting and phrases out of this draft, and its manner in", () => {
    const other = voiceForLanguage(profile("", "en"), "es");
    expect(other.habits.greetings).toEqual([]);
    expect(other.habits.signOffs).toEqual([]);
    expect(other.phrases).toEqual([]);
    expect(other.habits.exclamation).toBe(0.5);
    expect(other.habits.words.median).toBe(20);
  });

  it("a mixed level keeps only its manner, since it holds the other language's greetings too", () => {
    const mixed = profile("", "en");
    mixed.habits.languages = [{ text: "en", share: 0.6 }, { text: "es", share: 0.4 }];
    const voice = voiceForLanguage(mixed, "en");
    expect(voice.habits.greetings).toEqual([]);
    expect(voice.phrases).toEqual([]);
  });

  it("no level argues for its own language", () => {
    expect(voiceForLanguage(profile("es", "es"), "es").habits.languages).toEqual([]);
  });
});

describe("languageName", () => {
  it("names what it can tell the model", () => {
    expect(languageName("es")).toBe("Spanish");
    expect(languageName("xx")).toBeNull();
  });
});
