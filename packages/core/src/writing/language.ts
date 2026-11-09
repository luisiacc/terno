import type { Habits, Share, VoiceProfile } from "./types";

/**
 * Which language a draft is written in. Someone may write Spanish from one account and English from another, or to one
 * person and not their colleague, in any combination: so it's decided per account and person, from what they've done.
 */

const WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set("the and you to is for that it of thanks please we be will have this with are can your on i i'm not was but at in hi hello yes let's me my our from so if do works sounds good".split(" ")),
  es: new Set("el la que de y en los las por para con una un es gracias saludos hola nos te lo le se su al del usted no como pero más sí muy bien estimado estimada buenas".split(" ")),
  fr: new Set("le la les des et est que pour dans une un vous nous je merci bonjour avec pas sur ce cette au aux du votre notre cordialement oui salut".split(" ")),
  pt: new Set("o os as e é que para com uma um você vocês nós eu obrigado obrigada olá não em na no dos das por mais seu sua atenciosamente".split(" ")),
  de: new Set("der die das und ist nicht ich sie wir mit für auf ein eine zu den dem danke bitte hallo grüße von haben wird".split(" ")),
  it: new Set("il lo la le gli e è che per con una un non sono ho grazie ciao buongiorno della del di in su cordiali saluti anche".split(" ")),
  nl: new Set("de het een en is niet ik je we met voor op van dat zijn dank groeten hallo bedankt graag".split(" ")),
};

/** Letters only one language among these uses. */
const TELLS: readonly [RegExp, string][] = [
  [/[ñ¿¡]/u, "es"],
  [/[ãõ]/u, "pt"],
  [/ß/u, "de"],
];

/** Scripts that say the language outright, kana before Han since Japanese uses both. */
const SCRIPTS: readonly [RegExp, string][] = [
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/gu, "ja"],
  [/\p{Script=Hangul}/gu, "ko"],
  [/\p{Script=Han}/gu, "zh"],
  [/\p{Script=Cyrillic}/gu, "ru"],
  [/\p{Script=Arabic}/gu, "ar"],
  [/\p{Script=Hebrew}/gu, "he"],
  [/\p{Script=Greek}/gu, "el"],
  [/\p{Script=Devanagari}/gu, "hi"],
  [/\p{Script=Thai}/gu, "th"],
];

/** A language's code, or "" when the text doesn't say: short mail often doesn't, and a guess would do harm. */
export function detectWritingLanguage(text: string): string {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return "";
  for (const [script, language] of SCRIPTS) {
    // a share, since a Japanese name in an English mail doesn't make it Japanese; kana alone is enough for Japanese
    const count = text.match(script)?.length ?? 0;
    if (count / letters >= (language === "ja" ? 0.1 : 0.3)) return language;
  }
  const lower = text.toLowerCase();
  // each word once: "in London, dinner in Soho" is one word of evidence, not two
  const words = new Set(lower.match(/\p{L}[\p{L}'’]*/gu) ?? []);
  const score: Record<string, number> = {};
  const own: Record<string, number> = {};
  for (const word of words) {
    const speakers = Object.entries(WORDS).filter(([, list]) => list.has(word)).map(([language]) => language);
    for (const language of speakers) score[language] = (score[language] ?? 0) + 1;
    if (speakers.length === 1) own[speakers[0]!] = (own[speakers[0]!] ?? 0) + 1;
  }
  for (const [tell, language] of TELLS) {
    if (tell.test(lower) && score[language]) {
      score[language] += 2;
      own[language] = (own[language] ?? 0) + 1;
    }
  }
  const [first, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  // a word only this language has, or it's a guess between languages that share them
  return first && first[1] >= 2 && first[1] > (second?.[1] ?? 0) && own[first[0]] ? first[0] : "";
}

/**
 * A question's small words in the languages Terno ships. A question is short and rarely gives detectWritingLanguage
 * enough, so it's read by how it asks: its question words and the words around them. Words both languages write the
 * same ("me", "no", "has", "son") say nothing.
 */
const QUESTION_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set("what what's whats when when's where where's who who's whom whose why how which did does do is are was were has had have the my any anything about say said says tell show find list give get last many much there from of with for this that these those can could should would will ever since before after and or i it he she they we you your her him his them their our an in on at to reply replied answer answered send sent pay paid owe need know ask asked write wrote book booked sign signed mention mentioned due yet".split(" ")),
  es: new Set("qué que cuándo cuando dónde donde adónde quién quien quiénes quienes por porqué cómo como cuál cual cuáles cuales cuánto cuanto cuánta cuántos cuantos cuántas dijo dijeron tengo tiene tienen tenía hay hubo algún alguna alguno el la los las mi mis tu tus su sus sobre del al de para con una un es fue fueron está están estaba y o si ya pero también algo nada desde antes después dime muéstrame busca puedes puede decirme saber sé necesito debo ella él ellos ellas le les lo pagaron pagó pagué pago mandó mandaron envió enviaron respondió respondieron contestó contesté escribió escribí".split(" ")),
};

/** What's in quotation marks is the mail's words, not the question's: "When is “la cena de gala”?" asks in English. */
const QUOTED = /(["“«])[^"”»\n]*["”»]|(^|\s)'[^'\n]*'(?=[\s?.!,;:]|$)/gu;

/**
 * The language a question to Ask is in, so the answer can be told it outright: a model reading Spanish mail drifts into
 * Spanish whatever the rules say. "" when the question doesn't say, and the caller falls back.
 */
export function questionLanguage(question: string): string {
  const text = question.replace(QUOTED, " ");
  // a language Terno doesn't ship is only ever named by the general reading; en and es by how the question asks
  const general = detectWritingLanguage(text);
  if (general && general !== "en" && general !== "es" && languageName(general)) return general;
  const words = text.toLowerCase().match(/\p{L}[\p{L}'’]*/gu) ?? [];
  const score: Record<string, number> = { en: 0, es: 0 };
  for (const [language, list] of Object.entries(QUESTION_WORDS)) {
    for (const word of words) if (list.has(word.replace(/’/g, "'"))) score[language]! += 1;
    // how it opens is how it asks: "When is el pago de la factura?" is English, whatever words it borrows from the mail
    if (words[0] && list.has(words[0])) score[language]! += 3;
  }
  if (/[¿¡]/u.test(text)) score.es! += 3;
  // é is French's as much: only the others; and with Spanish words, since "María?" is a name, not a language
  if (score.es && /[ñáíóú]/u.test(text.toLowerCase())) score.es! += 1;
  if (score.en === score.es) return general;
  return score.en! > score.es! ? "en" : "es";
}

/** The names a person might use in an instruction: "in Spanish", "en inglés". Only ones Terno can also keep a voice for. */
const NAMED: readonly [RegExp, string][] = [
  [/\b(?:in|en|em|auf|na|lingua)\s+(?:english|ingl[eé]s|anglais|englisch|ingl[eê]s|inglese|engels)\b/iu, "en"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:spanish|espa[nñ]ol|castellano|espagnol|spanisch|espanhol|spagnolo|spaans)\b/iu, "es"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:french|franc[eé]s|fran[cç]ais|franz[oö]sisch|franc[eê]s|francese|frans)\b/iu, "fr"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:portuguese|portugu[eé]s|portugais|portugiesisch|portugu[eê]s|portoghese|portugees)\b/iu, "pt"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:german|alem[aá]n|allemand|deutsch|alem[aã]o|tedesco|duits)\b/iu, "de"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:italian|italiano|italien|italienisch|italiaans)\b/iu, "it"],
  [/\b(?:in|en|em|auf|lingua)\s+(?:dutch|holand[eé]s|n[eé]erlandais|niederl[aä]ndisch|olandese|nederlands)\b/iu, "nl"],
];

const NEGATION = /(?:^|[\s,;(])(?:not|never|no|nunca|pas|nicht|n[aã]o|non|niet)\s+$/iu;

/** The one language the instruction asks for: "in Spanish, not in English" is Spanish. Asking for two decides nothing here. */
export function namedLanguage(instruction: string): string | null {
  const asked = new Set<string>();
  for (const [name, language] of NAMED) {
    for (const match of instruction.matchAll(new RegExp(name.source, `${name.flags}g`))) {
      if (!NEGATION.test(instruction.slice(0, match.index))) asked.add(language);
    }
  }
  return asked.size === 1 ? [...asked][0]! : null;
}

/** How the model is told. A code it isn't named here goes unsaid, and the prompt's own rule decides. */
const NAMES: Readonly<Record<string, string>> = { en: "English", es: "Spanish", fr: "French", pt: "Portuguese", de: "German", it: "Italian", nl: "Dutch", ja: "Japanese", ko: "Korean", zh: "Chinese", ru: "Russian", ar: "Arabic", he: "Hebrew", el: "Greek", hi: "Hindi", th: "Thai" };

export const languageName = (code: string): string | null => NAMES[code] ?? null;

export type LanguageReason = "asked" | "thread" | "person" | "inbound" | "otherAccount" | "domain" | "account" | "you" | "instruction" | "unknown";

export interface LanguageChoice {
  language: string;
  reason: LanguageReason;
}

export interface LanguageEvidence {
  instruction: string;
  /** what the author has written in this conversation, newest first */
  threadOwn: readonly string[];
  /** the message being answered; "" when there's none, or it doesn't say */
  inbound: string;
  /** what this account has written to this person, newest first */
  toPerson: readonly string[];
  /** the levels' habits */
  otherAccount?: Pick<Habits, "languages"> | null;
  domain?: Pick<Habits, "languages"> | null;
  account?: Pick<Habits, "languages"> | null;
  you?: Pick<Habits, "languages"> | null;
}

/** Enough of a person's mail, and enough of it one language, to call it a habit a reply should keep to. */
const HABIT_MESSAGES = 3;
const HABIT_SHARE = 0.7;
/** What they do now: someone who moved to English with a client a year ago writes English to them. */
const RECENT_MESSAGES = 12;

function topOfCounts(languages: readonly string[]): { language: string; share: number; known: number } | null {
  const counts = new Map<string, number>();
  for (const l of languages) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!known) return null;
  const [language, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { language, share: count / known, known };
}

const topOfShares = (shares: readonly Share[] | undefined) => (shares?.[0]?.text && shares[0].share >= 0.5 ? shares[0].text : "");

/**
 * Most specific first. A reply follows the other person unless this account has a settled habit with them, so someone
 * who always answers a client in Spanish keeps doing so when the client writes in English. A person with mixed history
 * has no habit, and the conversation decides.
 */
export function chooseLanguage(e: LanguageEvidence): LanguageChoice {
  const asked = namedLanguage(e.instruction);
  if (asked) return { language: asked, reason: "asked" };
  const own = e.threadOwn.find(Boolean);
  if (own) return { language: own, reason: "thread" };
  const person = topOfCounts(e.toPerson.slice(0, RECENT_MESSAGES));
  if (person && person.known >= HABIT_MESSAGES && person.share >= HABIT_SHARE) return { language: person.language, reason: "person" };
  if (e.inbound) return { language: e.inbound, reason: "inbound" };
  if (person) return { language: person.language, reason: "person" };
  const levels: [LanguageReason, Pick<Habits, "languages"> | null | undefined][] = [["otherAccount", e.otherAccount], ["domain", e.domain], ["account", e.account], ["you", e.you]];
  for (const [reason, habits] of levels) {
    const language = topOfShares(habits?.languages);
    if (language) return { language, reason };
  }
  const typed = detectWritingLanguage(e.instruction);
  return typed ? { language: typed, reason: "instruction" } : { language: "", reason: "unknown" };
}

const PURE_SHARE = 0.9;

/**
 * A level as it applies to this language. Its length, punctuation and manner hold across languages, but a greeting,
 * sign-off or stock phrase from another language would be copied into this one. The language itself is the task's to
 * state, so no level argues for its own.
 */
export function voiceForLanguage(profile: VoiceProfile, language: string): VoiceProfile {
  const top = profile.habits.languages[0];
  // a level with a real share of another language holds that language's greetings too: only its manner carries
  const fits = !language || profile.language === language || (top?.text === language && top.share >= PURE_SHARE);
  const habits = { ...profile.habits, languages: [] };
  if (fits) return { ...profile, habits };
  return { ...profile, phrases: [], habits: { ...habits, greetings: [], noGreeting: 0, signOffs: [], noSignOff: 0 } };
}
