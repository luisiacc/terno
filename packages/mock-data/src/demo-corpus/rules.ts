/**
 * Plan 292: what every source of the written demo mailbox must hold. The writer agents run these through
 * `scripts/demo-corpus/check.mjs` until their batch passes; the corpus test runs them over everything committed.
 * Self-contained on purpose: Node runs this file with type stripping, so it imports types only.
 */
import type { BulkSource, MailingList, MessageRecord, Person, Seed, SpamSource, ThreadRecord, World } from "./types";

export interface Issue {
  level: "error" | "warn";
  where: string;
  message: string;
}

/** Real companies and products: never a sender, a brand or an organisation (the demo is fictional). */
export const REAL_NAMES = [
  "google", "gmail", "youtube", "amazon", "apple", "icloud", "microsoft", "outlook", "hotmail", "uber", "lyft", "bolt", "cabify", "didi",
  "github", "gitlab", "linkedin", "netflix", "spotify", "airbnb", "booking.com", "expedia", "paypal", "stripe", "wise", "revolut", "monzo",
  "slack", "zoom", "notion", "figma", "dropbox", "twitter", "facebook", "instagram", "whatsapp", "tiktok", "medium", "substack", "mailchimp",
  "canva", "adobe", "atlassian", "jira", "trello", "asana", "linear", "vercel", "heroku", "docusign", "calendly", "shopify", "etsy", "ebay",
  "deliveroo", "doordash", "instacart", "rappi", "mercadolibre", "mercado libre", "oxxo", "telcel", "vodafone", "tesco", "sainsbury", "ikea",
  "zara", "nike", "ryanair", "easyjet", "british airways", "aeromexico", "aeroméxico", "bbva", "santander", "hsbc", "barclays", "banorte",
  "banamex", "nubank", "morning brew", "xataka", "platzi", "trainline", "ocado", "starbucks", "costco", "walmart", "openai", "anthropic",
];
/** Webmail domains a person's address may use; anything else in a person's address must be an org's domain or invented. */
export const WEBMAIL = ["gmail.com", "icloud.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me", "me.com", "hey.com"];

/** Phrases that mark text as written by a model, not typed by a person. */
export const MODEL_TELLS = [
  "i hope this email finds you well", "i hope this message finds you well", "i hope this finds you well", "i wanted to reach out",
  "please don't hesitate", "please do not hesitate", "delve", "as an ai", "i trust this email", "spero que este correo",
  "espero que este correo te encuentre bien", "espero que este correo le encuentre bien", "espero que te encuentres bien",
  "tapestry", "navigate the complexities", "rest assured",
];

const SPANISH_CHARS = /[áéíóúñ¿¡ÁÉÍÓÚÑ]/;
const ES_WORDS = new Set(["que", "de", "el", "la", "los", "las", "por", "para", "con", "una", "un", "es", "en", "lo", "se", "te", "le", "nos", "pero", "más", "gracias", "hola", "saludos", "y", "si", "ya", "está", "tengo", "quedo"]);
const EN_WORDS = new Set(["the", "and", "to", "of", "is", "it", "that", "for", "you", "with", "on", "this", "be", "are", "have", "will", "can", "thanks", "hi", "we", "i", "my", "your", "just", "if", "at"]);
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

const words = (text: string) => text.toLowerCase().match(/[a-záéíóúñü']+/g) ?? [];
/** "en" | "es" | null: which of the two the text reads as, by function words */
export function readsAs(text: string): "en" | "es" | null {
  let en = 0;
  let es = 0;
  for (const w of words(text)) {
    if (EN_WORDS.has(w)) en++;
    if (ES_WORDS.has(w)) es++;
  }
  if (en + es < 3) return null;
  return en > es * 1.5 ? "en" : es > en * 1.5 ? "es" : null;
}

/**
 * Every address outside webmail, and every link, is on the reserved `.example` suffix (RFC 2606): the demo reaches no
 * one's server, not even for a sender icon (the icon service skips names outside the public suffix list).
 */
export const inertDomain = (domain: string) => WEBMAIL.includes(domain) || domain.endsWith(".example");
const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
export function foreignLinks(text: string): string[] {
  return [...text.matchAll(URL_HOST)].map((m) => m[1]!.toLowerCase()).filter((h) => !h.endsWith(".example"));
}

const WEEKDAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const EN_A = new RegExp(`\\b(${WEEKDAYS_EN.join("|")}),? (?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTHS_EN.join("|")})\\b`, "gi");
const EN_B = new RegExp(`\\b(${WEEKDAYS_EN.join("|")}),? (${MONTHS_EN.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const ES_A = new RegExp(`(?<![\\p{L}])(${WEEKDAYS_ES.join("|")}),? (\\d{1,2}) de (${MONTHS_ES.join("|")})(?![\\p{L}])`, "giu");

/**
 * "Thursday 6 November" must be a Thursday: the year is the one that puts the date nearest the message's own (within
 * about six months either side). Returns each named day that is wrong.
 */
export function wrongWeekdays(text: string, sent: number): string[] {
  const out: string[] = [];
  const test = (weekday: number, day: number, month: number, said: string) => {
    const year = new Date(sent).getUTCFullYear();
    const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, month, day, 12));
    const best = candidates.reduce((a, b) => (Math.abs(b - sent) < Math.abs(a - sent) ? b : a));
    if (new Date(best).getUTCDate() !== day) return; // 31 February: not a date at all
    if (new Date(best).getUTCDay() !== weekday) out.push(`"${said}" is a ${WEEKDAYS_EN[new Date(best).getUTCDay()]} (${new Date(best).toISOString().slice(0, 10)})`);
  };
  for (const m of text.matchAll(EN_A)) test(WEEKDAYS_EN.indexOf(m[1]!.toLowerCase()), Number(m[2]), MONTHS_EN.indexOf(m[3]!.toLowerCase()), m[0]);
  for (const m of text.matchAll(EN_B)) test(WEEKDAYS_EN.indexOf(m[1]!.toLowerCase()), Number(m[3]), MONTHS_EN.indexOf(m[2]!.toLowerCase()), m[0]);
  for (const m of text.matchAll(ES_A)) test(WEEKDAYS_ES.indexOf(m[1]!.toLowerCase()), Number(m[2]), MONTHS_ES.indexOf(m[3]!.toLowerCase()), m[0]);
  return out;
}

/** minutes east of UTC an ISO date says, or null */
function offsetOf(iso: string): number | null {
  if (iso.endsWith("Z")) return 0;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
}
/** minutes east of UTC in `zone` at `utc`, or null for a zone this runtime doesn't know */
export function zoneOffset(utc: number, zone: string): number | null {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(utc);
    const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return Math.round((Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) - Math.floor(utc / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}
const formatOffset = (min: number) => `${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}:${String(Math.abs(min) % 60).padStart(2, "0")}`;

const realName = (s: string) => {
  const l = s.toLowerCase();
  return REAL_NAMES.find((n) => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(l));
};

function checkPerson(p: Person, where: string, world: World, out: Issue[]) {
  const err = (message: string) => out.push({ level: "error", where, message });
  if (!ID.test(p.id)) err(`id "${p.id}" isn't kebab-case`);
  if (!EMAIL.test(p.email)) err(`address "${p.email}" isn't a lower-case address`);
  const domain = p.email.split("@")[1] ?? "";
  if (!inertDomain(domain)) err(`address "${p.email}": outside webmail (${WEBMAIL.join(", ")}) every domain ends in .example`);
  if (p.lang !== "en" && p.lang !== "es") err(`lang "${p.lang}"`);
  if (!p.timezone.includes("/") && p.timezone !== "UTC") err(`timezone "${p.timezone}" isn't an IANA zone`);
  for (const a of p.accounts ?? []) if (!world.accounts.some((x) => x.key === a)) err(`account "${a}" doesn't exist`);
  if (p.org && !world.orgs.some((o) => o.id === p.org)) err(`org "${p.org}" doesn't exist`);
  if (!p.style || !p.style.register || !p.style.quoting) err("no style card");
  if (p.accounts?.some((a) => world.accounts.find((x) => x.key === a)?.lang === "en") && SPANISH_CHARS.test(p.name)) err(`"${p.name}" writes to an English account: no Spanish accents in the name (plan 289)`);
}

export function validateWorld(world: World): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, message: string) => out.push({ level: "error", where, message });
  if (Number.isNaN(Date.parse(world.anchor))) err("anchor", "not a date");
  if (!world.owner?.bio) err("owner", "no bio");
  // the accounts are created first when the mailbox is seeded: one that can't be is caught here, before any write
  const keys = new Set<string>();
  for (const a of world.accounts ?? []) {
    const where = `accounts/${a.key}`;
    if (keys.has(a.key)) err(where, "twice");
    keys.add(a.key);
    if (a.kind !== "gmail" && a.kind !== "imap") err(where, `kind "${a.kind}"`);
    if (a.lang !== "en" && a.lang !== "es") err(where, `lang "${a.lang}"`);
    if (!EMAIL.test(a.email ?? "")) err(where, `address "${a.email}"`);
    if (!a.displayName || !a.ownerName || !a.color) err(where, "needs displayName, ownerName and color");
    if (!Array.isArray(a.folders)) err(where, "folders");
  }
  if (!world.accounts?.length) err("accounts", "none");
  if (!world.categories?.length) err("categories", "none");
  for (const lang of ["en", "es"] as const) if (!world.owner?.style?.[lang]) err("owner", `no ${lang} style card`);
  const ids = new Set<string>();
  const emails = new Set(world.accounts.map((a) => a.email));
  for (const p of world.people) {
    if (ids.has(p.id)) err(`people/${p.id}`, "duplicate id");
    ids.add(p.id);
    if (emails.has(p.email)) err(`people/${p.id}`, `duplicate address ${p.email}`);
    emails.add(p.email);
    checkPerson(p, `people/${p.id}`, world, out);
  }
  const orgIds = new Set<string>();
  for (const o of world.orgs) {
    if (orgIds.has(o.id)) err(`orgs/${o.id}`, "duplicate id");
    orgIds.add(o.id);
    const r = realName(o.name) ?? realName(o.domain.replace(/\.[a-z]+$/, ""));
    if (r) err(`orgs/${o.id}`, `"${r}" is a real company`);
    if (!o.domain.endsWith(".example")) err(`orgs/${o.id}`, `domain ${o.domain} doesn't end in .example`);
  }
  const brandIds = new Set<string>();
  for (const b of world.brands) {
    if (brandIds.has(b.id)) err(`brands/${b.id}`, "duplicate id");
    brandIds.add(b.id);
    const r = realName(b.name) ?? realName(b.domain.replace(/\.[a-z]+$/, "")) ?? realName(b.fromEmail.split("@")[1]!.replace(/\.[a-z]+$/, ""));
    if (r) err(`brands/${b.id}`, `"${r}" is a real company`);
    if (!b.fromEmail.endsWith(`@${b.domain}`) && !b.fromEmail.endsWith(`.${b.domain}`)) err(`brands/${b.id}`, `sender ${b.fromEmail} isn't on ${b.domain}`);
    if (!b.domain.endsWith(".example")) err(`brands/${b.id}`, `domain ${b.domain} doesn't end in .example`);
    for (const a of b.accounts) {
      const acc = world.accounts.find((x) => x.key === a);
      if (!acc) err(`brands/${b.id}`, `account "${a}" doesn't exist`);
      else if (acc.lang !== b.lang) err(`brands/${b.id}`, `writes ${b.lang} to ${a}, a ${acc.lang} account`);
    }
  }
  for (const s of world.storylines) {
    for (const p of s.people) if (!ids.has(p)) err(`storylines/${s.id}`, `person "${p}" doesn't exist`);
    if (!world.accounts.some((a) => a.key === s.account)) err(`storylines/${s.id}`, `account "${s.account}"`);
  }
  for (let i = 1; i < world.timeline.length; i++) if (world.timeline[i]!.date < world.timeline[i - 1]!.date) err(`timeline/${i}`, "out of order");
  return out;
}

function checkMessage(m: MessageRecord, i: number, t: ThreadRecord, known: Map<string, Person>, world: World, out: Issue[]) {
  const where = `${t.id}/message ${i + 1}`;
  const err = (message: string) => out.push({ level: "error", where, message });
  const warn = (message: string) => out.push({ level: "warn", where, message });
  const party = (id: string) => id === "me" || known.has(id) || (id === "list" && Boolean(t.listId));
  if (!party(m.from)) err(`from "${m.from}" isn't a person`);
  for (const id of [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])]) if (!party(id)) err(`recipient "${id}" isn't a person`);
  if (!m.to.length) err("no To");
  const recipients = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])];
  if (m.from !== "me" && !recipients.includes("me") && !recipients.includes("list")) err("the owner neither sent nor received it (on a list, address it to \"list\")");
  if (!OFFSET_ISO.test(m.date) || Number.isNaN(Date.parse(m.date))) err(`date "${m.date}" isn't ISO with an offset`);
  if (Date.parse(m.date) > Date.parse(world.anchor)) err(`dated after the anchor (${world.anchor})`);
  // a person's mail carries their zone's offset on that day (London is +00:00 in winter); a warning, people travel
  const zone = m.from === "me" ? undefined : known.get(m.from)?.timezone; // he travels (Christmas in Guadalajara): not checked
  const said = offsetOf(m.date);
  if (zone && said !== null && OFFSET_ISO.test(m.date)) {
    const want = zoneOffset(Date.parse(m.date), zone);
    if (want !== null && want !== said) warn(`offset ${m.date.slice(-6)} isn't ${zone}'s on that day (${formatOffset(want)})`);
  }
  if (typeof m.read !== "boolean") err("read is missing");
  const text = m.text ?? "";
  if (!text.trim()) err("empty text");
  if (/^>/m.test(text) || /\bwrote:\s*$/m.test(text) || /\bescribió:\s*$/m.test(text) || /-{3,}\s*(Forwarded|Mensaje reenviado)/i.test(text)) err("contains quoted history or a forwarded block: the loader adds those");
  const lower = text.toLowerCase();
  for (const tell of MODEL_TELLS) if (lower.includes(tell)) err(`model tell: "${tell}"`);
  const dashes = (text.match(/—/g) ?? []).length;
  if (dashes > 1) warn(`${dashes} em dashes`);
  const lang = world.accounts.find((a) => a.key === t.account)?.lang;
  if (lang === "en" && SPANISH_CHARS.test(text + (m.subject ?? ""))) err("Spanish letters on an English account (plan 289)");
  const reads = readsAs(text);
  if (lang && reads && reads !== lang) err(`reads as ${reads} on a ${lang} account`);
  const r = realName(text);
  if (r) warn(`mentions "${r}", a real company`);
  for (const host of foreignLinks(text)) err(`link to ${host}: links go to .example hosts only`);
  for (const w of wrongWeekdays(text, Date.parse(m.date))) err(`weekday and date disagree: ${w}`);
  for (const a of m.attachments ?? []) if (!a.filename || !a.mime || !(a.size > 0)) err("an attachment needs filename, mime, size");
}

export function validateThreads(world: World, threads: ThreadRecord[], seeds: Seed[] = [], lists?: MailingList[]): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, message: string) => out.push({ level: "error", where, message });
  const people = new Map(world.people.map((p) => [p.id, p]));
  const seedOf = new Map(seeds.map((s) => [s.id, s]));
  const threadIds = new Set<string>();
  const oneOff = new Map<string, string>();
  for (const t of threads) {
    const where = t.id ?? "?";
    if (threadIds.has(t.id)) err(where, "duplicate thread id");
    threadIds.add(t.id);
    const account = world.accounts.find((a) => a.key === t.account);
    if (!account) {
      err(where, `account "${t.account}"`);
      continue;
    }
    if (t.lang !== account.lang) err(where, `lang ${t.lang} on a ${account.lang} account`);
    if (!t.subject?.trim()) err(where, "no subject");
    if (account.lang === "en" && SPANISH_CHARS.test(t.subject)) err(where, "Spanish letters in the subject of an English account");
    if (t.folder && !account.folders.some((f) => f.key === t.folder && f.selectable)) err(where, `folder "${t.folder}" isn't one of ${t.account}'s`);
    if (t.storyline && !world.storylines.some((s) => s.id === t.storyline)) err(where, `storyline "${t.storyline}" doesn't exist`);
    if (t.listId && lists && !lists.some((l) => l.listId === t.listId && l.account === t.account)) err(where, `listId "${t.listId}" isn't one of ${t.account}'s lists in lists.json`);
    if (!t.tags?.length) err(where, "no tags");
    if (!t.state || typeof t.state.inbox !== "boolean") err(where, "no state.inbox");
    const known = new Map(people);
    for (const p of t.people ?? []) {
      if (people.has(p.id)) err(where, `one-off person "${p.id}" shadows a world person`);
      const prior = oneOff.get(p.id);
      if (prior && prior !== t.id) err(where, `one-off person "${p.id}" is also defined in ${prior}`);
      oneOff.set(p.id, t.id);
      known.set(p.id, p);
      checkPerson({ ...p, accounts: p.accounts ?? [t.account] }, `${where}/people/${p.id}`, world, out);
    }
    if (!t.messages?.length) {
      err(where, "no messages");
      continue;
    }
    t.messages.forEach((m, i) => checkMessage(m, i, t, known, world, out));
    for (let i = 1; i < t.messages.length; i++) if (Date.parse(t.messages[i]!.date) <= Date.parse(t.messages[i - 1]!.date)) err(`${where}/message ${i + 1}`, "not after the message before it");
    if (!t.truth || typeof t.truth.summary !== "string" || !Array.isArray(t.truth.ownerOwes) || !Array.isArray(t.truth.facts)) err(where, "truth is incomplete");
    const seed = seedOf.get(t.id);
    if (seed) checkSeed(seed, t, out);
    else if (seeds.length) err(where, "no seed has this id");
  }
  for (const s of seeds) if (!threadIds.has(s.id)) err(s.id, "seed not written");
  return out;
}

const BUILTINS = new Set(["date", "time", "weekday", "month", "year", "first"]);
const ZONE = /^[A-Z][A-Za-z_]+\/[A-Za-z_]+$|^UTC$/;

/** The machine mail's templates and the spam: links on .example only, slots defined, schedules a loader can expand. */
export function validateBulk(world: World, bulk: BulkSource[], spam: SpamSource[]): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, message: string) => out.push({ level: "error", where, message });
  const warn = (where: string, message: string) => out.push({ level: "warn", where, message });
  const seen = new Set<string>();
  for (const b of bulk) {
    const where = `bulk/${b.brand}/${b.account}`;
    const brand = world.brands.find((x) => x.id === b.brand);
    if (!brand) {
      err(where, "no such brand in world.json");
      continue;
    }
    if (seen.has(where)) err(where, "twice");
    seen.add(where);
    if (!brand.accounts.includes(b.account)) err(where, `${b.brand} doesn't write to ${b.account}`);
    const s = b.schedule;
    if (!s || !["daily", "weekdays", "weekly", "fortnightly", "monthly", "random"].includes(s.every)) err(where, "schedule.every");
    else if (!ZONE.test(s.zone ?? "")) err(where, `schedule.zone "${s.zone}"`);
    else if (s.at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) err(where, `schedule.at "${s.at}"`);
    else if (zoneOffset(0, s.zone) === null) err(where, `schedule.zone "${s.zone}" isn't a zone this runtime knows`);
    else if ((s.every === "weekly" || s.every === "fortnightly") && s.day !== undefined && !(s.day >= 0 && s.day <= 6)) err(where, `schedule.day ${s.day}`);
    else if (s.every === "monthly" && (s.nth ? !(s.nth[0] >= 1 && s.nth[0] <= 5 && s.nth[1] >= 0 && s.nth[1] <= 6) : s.day !== undefined && !(s.day >= 1 && s.day <= 31))) err(where, "schedule.day or nth");
    else if ((s.from && Number.isNaN(Date.parse(s.from))) || (s.to && Number.isNaN(Date.parse(s.to)))) err(where, "schedule.from or to");
    const texts: [string, string][] = [];
    if (brand.kind === "newsletter") {
      const need = s?.every === "daily" || s?.every === "weekdays" ? 15 : s?.every === "weekly" || s?.every === "fortnightly" ? 6 : 3;
      if ((b.issues?.length ?? 0) < need) err(where, `${b.issues?.length ?? 0} issues, a ${s?.every} newsletter needs ${need}`);
      b.issues?.forEach((x, i) => texts.push([`${where}/issue ${i + 1}`, `${x.subject}\n${x.text}\n${x.html ?? ""}`]));
    } else if (!b.templates?.length) err(where, "no templates");
    b.templates?.forEach((t, i) => {
      const all = `${t.subject}\n${t.text}\n${t.html ?? ""}`;
      texts.push([`${where}/template ${i + 1}`, all]);
      for (const m of all.matchAll(/\{(\w+)\}/g)) if (!BUILTINS.has(m[1]!) && !t.slots?.[m[1]!]) err(`${where}/template ${i + 1}`, `{${m[1]}} has no slot`);
    });
    for (const [w, text] of texts) {
      for (const host of foreignLinks(text)) err(w, `link to ${host}: links go to .example hosts only`);
      if (/<script/i.test(text)) err(w, "a script");
      if (/\bsrc=["']https?:\/\/(?![a-z0-9.-]+\.example\b)/i.test(text)) err(w, "an image off .example");
      const lang = brand.lang;
      if (lang === "en" && SPANISH_CHARS.test(text.replace(/<[^>]+>/g, ""))) err(w, "Spanish letters on an English account");
      const lower = text.toLowerCase();
      for (const tell of MODEL_TELLS) if (lower.includes(tell)) warn(w, `model tell: "${tell}"`);
    }
  }
  for (const b of world.brands) for (const a of b.accounts) if (!seen.has(`bulk/${b.id}/${a}`)) warn(`brands/${b.id}`, `no bulk source for ${a} yet`);
  spam.forEach((s, i) => {
    const where = `spam/${i + 1}`;
    if (!world.accounts.some((a) => a.key === s.account)) err(where, `account "${s.account}"`);
    const domain = s.fromEmail.split("@")[1] ?? "";
    if (!domain.endsWith(".example")) err(where, `sender ${s.fromEmail}: spam comes from .example domains`);
    for (const host of foreignLinks(`${s.text}\n${s.html ?? ""}`)) err(where, `link to ${host}`);
    if (!(s.daysAgo >= 0 && s.daysAgo <= 730)) err(where, "daysAgo");
  });
  return out;
}

/** What a brief fixes that code can hold the writer to. */
function checkSeed(s: Seed, t: ThreadRecord, out: Issue[]) {
  const err = (message: string) => out.push({ level: "error", where: t.id, message });
  if (t.account !== s.account) err(`account ${t.account}, the seed says ${s.account}`);
  const n = t.messages.length;
  if (n < s.messages[0] || n > s.messages[1]) err(`${n} messages, the seed says ${s.messages[0]}–${s.messages[1]}`);
  const [from, to] = [Date.parse(s.window[0]), Date.parse(s.window[1]) + 86_400_000];
  t.messages.forEach((m, i) => {
    const d = Date.parse(m.date);
    if (d < from || d >= to) err(`message ${i + 1} (${m.date}) is outside the seed's window ${s.window[0]}–${s.window[1]}`);
  });
  if (t.state.inbox !== s.inbox) err(`inbox ${t.state.inbox}, the seed says ${s.inbox}`);
  if (Boolean(t.state.trash) !== Boolean(s.trash)) err(`trash ${Boolean(t.state.trash)}, the seed says ${Boolean(s.trash)}`);
  const first = t.messages[0]!;
  const last = t.messages.at(-1)!;
  if (s.firstFrom === "me" && first.from !== "me") err("the seed says the owner sends the first message");
  if (s.firstFrom === "them" && first.from === "me") err("the seed says someone else sends the first message");
  if (s.lastFrom === "me" && last.from !== "me") err("the seed says the owner sends the last message");
  if (s.lastFrom === "them" && last.from === "me") err("the seed says someone else sends the last message");
  if (s.list && !t.listId) err(`the seed is a discussion on the "${s.list}" list: set listId`);
  const cut = s.unreadFrom ? Date.parse(s.unreadFrom) : Infinity;
  t.messages.forEach((m, i) => {
    if (m.from === "me") return;
    const want = Date.parse(m.date) < cut;
    if (m.read !== want) err(`message ${i + 1} should be ${want ? "read" : "unread"} (${s.unreadFrom ? `unreadFrom ${s.unreadFrom}` : "the seed has no unreadFrom: all read"})`);
  });
  for (const p of s.people) if (!t.messages.some((m) => m.from === p || m.to.includes(p) || m.cc?.includes(p))) err(`seed person "${p}" isn't in the thread`);
}
