import type { Address, CategoryColor, Unsubscribe } from "@terno/core";
import { FAMILIES, FAMILY_SHARE, FAMILY_TAGS, familyThread, type AdversarialFamily, type FamilyMessage } from "./adversarial";
import * as B from "./banks";

/** Structurally compatible with @terno/db IncomingMessage, minus accountId. */
export interface MockMessage {
  accountIndex: number;
  providerMsgId: string;
  providerThreadId: string | null;
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  date: number;
  snippet: string;
  bodyText: string;
  bodyHtml: string | null;
  bodyState: "full";
  listId: string | null;
  /** sent with bulk headers (List-Unsubscribe, Precedence): newsletters, notifications, spam */
  bulk: boolean;
  /** plan 96: newsletters' List-Unsubscribe, a mailto only (the demo provider never sends, so the demo reaches no real site) */
  unsubscribe?: Unsubscribe;
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  isSent: boolean;
  isDraft: boolean;
  isTrash: boolean;
  isSpam: boolean;
  hasAttachments: boolean;
  size: number;
  attachments: { filename: string; mime: string; size: number }[];
  /** semantic tag of the message */
  tag: ThreadTag;
  /** gold labels of the thread (multi-label): seeded categories and the categorization eval use them */
  tags: ThreadTag[];
  /** set on adversarial threads */
  family?: AdversarialFamily;
  /** plan 68: Gmail: its user labels (folder keys); IMAP: its locations in the account's own folders */
  gmailLabels?: string[];
  locations?: { mailbox: string; uidvalidity: number; uid: number; flags: string[] }[];
}

export type ThreadTag = "newsletter" | "receipt" | "shipping" | "bank" | "dev" | "travel" | "calendar" | "work" | "client" | "personal" | "spam" | "promo" | "phish";

export interface MockAccount {
  kind: "imap" | "gmail";
  /** plan 289: the demo edition's: every conversation on the account in this language (the fixture's mix both) */
  lang?: B.Lang;
  email: string;
  displayName: string;
  color: string;
  ownerName: string;
  /** relative share of threads (skewed on purpose) */
  weight: number;
  /** plan 68: the account's own folders (Gmail labels, IMAP folders); keys are what its messages carry */
  folders?: { key: string; path: string[]; selectable: boolean; tags: ThreadTag[] }[];
}

export interface MockCategory {
  name: string;
  color: CategoryColor;
  tags: ThreadTag[];
}

/**
 * Plan 289: who the mailbox is for. `fixture` (the default) is what the tests, baselines and perf gates read, byte for
 * byte as before: three conversations in four Spanish, on every account. `demo` is what people look at (the demo
 * commands, the site's pictures): every account English but one, Freelance, in Spanish.
 */
export type Edition = "fixture" | "demo";

export interface GenerateOptions {
  seed?: number;
  edition?: Edition;
  /** number of conversation threads; messages ≈ threads × 2.5 */
  threads: number;
  accounts?: number;
  /** "now" anchor so data is reproducible */
  now?: number;
  /** spread of dates, in days */
  spanDays?: number;
  /** multiplies body length (perf fixtures use realistic ~1-2 KB bodies) */
  bodyScale?: number;
  /**
   * Adds the adversarial families of the categorization eval, generated from
   * their own PRNG after the regular threads, so output without it is
   * unchanged. `newAfter`: new-receipt senders only appear after this date;
   * `coldAfter`: every family only appears after it (cold-adversarial).
   */
  adversarial?: boolean | { newAfter?: number; coldAfter?: number };
}

export interface MockDataset {
  accounts: MockAccount[];
  categories: MockCategory[];
  messages: MockMessage[];
}

/** plan 68: each account's own folders, and which threads (by tag) a share of them hold */
const PERSONAL_LABELS: MockAccount["folders"] = [
  { key: "Label_11", path: ["Familia"], selectable: true, tags: ["personal"] },
  { key: "Label_12", path: ["Recibos"], selectable: true, tags: ["receipt", "bank"] },
  { key: "Label_13", path: ["Recibos", "Impuestos 2026"], selectable: true, tags: ["bank"] },
];
const ACME_LABELS: MockAccount["folders"] = [
  { key: "Label_21", path: ["Proyectos"], selectable: true, tags: ["work"] },
  { key: "Label_22", path: ["Proyectos", "Rediseño web"], selectable: true, tags: ["client"] },
  { key: "Label_23", path: ["Equipo"], selectable: true, tags: ["calendar"] },
];
const FREELANCE_FOLDERS: MockAccount["folders"] = [
  { key: "Clientes antiguos", path: ["Clientes antiguos"], selectable: true, tags: ["client"] },
  { key: "Facturación", path: ["Facturación"], selectable: false, tags: [] },
  { key: "Facturación/2026", path: ["Facturación", "2026"], selectable: true, tags: ["receipt"] },
];
const ICLOUD_FOLDERS: MockAccount["folders"] = [{ key: "Viajes guardados", path: ["Viajes guardados"], selectable: true, tags: ["travel"] }];

const ALL_ACCOUNTS: MockAccount[] = [
  { kind: "gmail", email: "luis.cordero@gmail.com", displayName: "Personal", color: "brown", ownerName: "Luis Cordero", weight: 0.32, folders: PERSONAL_LABELS },
  { kind: "gmail", email: "luis@acme.studio", displayName: "Acme Studio", color: "emerald", ownerName: "Luis Carlos Cordero", weight: 0.3, folders: ACME_LABELS },
  { kind: "imap", email: "hola@luiscordero.dev", displayName: "Freelance", color: "amber", ownerName: "Luis Cordero", weight: 0.14, folders: FREELANCE_FOLDERS },
  { kind: "imap", email: "lccordero@icloud.com", displayName: "iCloud", color: "cyan", ownerName: "Luis Cordero", weight: 0.08, folders: ICLOUD_FOLDERS },
  { kind: "gmail", email: "luis@orbitalabs.dev", displayName: "Orbita Labs", color: "violet", ownerName: "Luis Cordero", weight: 0.07 },
  { kind: "imap", email: "l.cordero@universidad.edu.mx", displayName: "Universidad", color: "rose", ownerName: "Luis Cordero Peña", weight: 0.04 },
  { kind: "imap", email: "luiscp@hotmail.com", displayName: "Hotmail (viejo)", color: "slate", ownerName: "Luis C.", weight: 0.03 },
  { kind: "gmail", email: "compras.luis@gmail.com", displayName: "Compras", color: "lime", ownerName: "Luis Cordero", weight: 0.02 },
];

/** plan 289: the demo's accounts: the fixture's, each in one language, the English ones' labels and folders in English */
const DEMO_ACCOUNTS: MockAccount[] = [
  {
    ...ALL_ACCOUNTS[0]!,
    lang: "en",
    folders: [
      { key: "Label_11", path: ["Family"], selectable: true, tags: ["personal"] },
      { key: "Label_12", path: ["Receipts"], selectable: true, tags: ["receipt", "bank"] },
      { key: "Label_13", path: ["Receipts", "Taxes 2026"], selectable: true, tags: ["bank"] },
    ],
  },
  {
    ...ALL_ACCOUNTS[1]!,
    lang: "en",
    folders: [
      { key: "Label_21", path: ["Projects"], selectable: true, tags: ["work"] },
      { key: "Label_22", path: ["Projects", "Website redesign"], selectable: true, tags: ["client"] },
      { key: "Label_23", path: ["Team"], selectable: true, tags: ["calendar"] },
    ],
  },
  { ...ALL_ACCOUNTS[2]!, lang: "es" },
  { ...ALL_ACCOUNTS[3]!, lang: "en", folders: [{ key: "Saved trips", path: ["Saved trips"], selectable: true, tags: ["travel"] }] },
  { ...ALL_ACCOUNTS[4]!, lang: "en" },
  { ...ALL_ACCOUNTS[5]!, lang: "en", displayName: "University", ownerName: "Luis Cordero" },
  { ...ALL_ACCOUNTS[6]!, lang: "en", displayName: "Hotmail (old)" },
  { ...ALL_ACCOUNTS[7]!, lang: "en", displayName: "Shopping" },
];
/** Plan 289: the demo mailbox `seedDemo` seeds for the demo commands (the site's picture checks generate it again). */
export const DEMO_DATASET = { threads: 3000, accounts: 4, seed: 42, bodyScale: 2, edition: "demo" } as const satisfies GenerateOptions;

/** the index of the demo's Spanish account (Freelance) */
export const DEMO_SPANISH_ACCOUNT = DEMO_ACCOUNTS.findIndex((a) => a.lang === "es");

/** plan 289: the demo's categories, in English (the order and colors are the fixture's) */
export const DEMO_CATEGORIES: MockCategory[] = [
  { name: "Receipts", color: "amber", tags: ["receipt", "bank"] },
  { name: "Clients", color: "emerald", tags: ["client"] },
  { name: "Travel", color: "cyan", tags: ["travel"] },
  { name: "Reading", color: "violet", tags: ["newsletter"] },
  { name: "Dev", color: "brown", tags: ["dev"] },
];

/** What an account's mail draws from: in the fixture one shared, mixed set; in the demo one per language. */
interface Pools {
  first: readonly string[];
  last: readonly string[];
  newsletters: readonly B.NewsletterSource[];
  notifiers: readonly B.NotificationSource[];
  spammers: readonly Address[];
  spamSubjects: readonly string[];
  spamBody: string;
  personalSubjects: readonly string[];
  projects: readonly string[];
  clients: readonly { name: string; domain: string }[];
  attachments: readonly { filename: string; mime: string }[];
}
const FIXTURE_POOLS: Pools = {
  first: B.FIRST_NAMES,
  last: B.LAST_NAMES,
  newsletters: B.NEWSLETTERS,
  notifiers: B.NOTIFIERS,
  spammers: B.SPAMMERS,
  spamSubjects: ["¡¡Felicidades!! Has ganado un iPhone 17", "URGENT: claim your prize now", "💰 Gana $5,000 diarios desde casa", "Your account will be suspended"],
  spamBody: "Haz clic aquí para reclamar tu premio antes de que expire la oferta.",
  personalSubjects: B.PERSONAL_SUBJECTS,
  projects: B.PROJECT_WORDS,
  clients: B.CLIENT_COMPANIES,
  attachments: B.ATTACHMENT_NAMES,
};
const DEMO_POOLS: Record<B.Lang, Pools> = {
  en: {
    first: B.EN_FIRST_NAMES,
    last: B.EN_LAST_NAMES,
    newsletters: B.EN_NEWSLETTERS,
    notifiers: B.EN_NOTIFIERS,
    spammers: B.EN_SPAMMERS,
    spamSubjects: B.SPAM.en.subjects,
    spamBody: B.SPAM.en.body,
    personalSubjects: B.EN_PERSONAL_SUBJECTS,
    projects: B.EN_PROJECT_WORDS,
    clients: B.EN_CLIENT_COMPANIES,
    attachments: B.EN_ATTACHMENT_NAMES,
  },
  es: {
    first: B.ES_FIRST_NAMES,
    last: B.ES_LAST_NAMES,
    newsletters: B.ES_NEWSLETTERS,
    notifiers: B.ES_NOTIFIERS,
    spammers: B.ES_SPAMMERS,
    spamSubjects: B.SPAM.es.subjects,
    spamBody: B.SPAM.es.body,
    personalSubjects: B.ES_PERSONAL_SUBJECTS,
    projects: B.PROJECT_WORDS,
    clients: B.ES_CLIENT_COMPANIES,
    attachments: B.ATTACHMENT_NAMES,
  },
};

/** How one language writes a conversation (the fixture's English has fewer sentences and subjects than the demo's). */
const voice = (lang: B.Lang, demo: boolean) =>
  lang === "es"
    ? { openers: B.OPENERS_ES, closers: B.CLOSERS_ES, sentences: B.SENTENCES_ES, workSubjects: B.WORK_SUBJECTS_ES }
    : { openers: B.OPENERS_EN, closers: B.CLOSERS_EN, sentences: demo ? B.EN_SENTENCES : B.SENTENCES_EN, workSubjects: demo ? B.EN_WORK_SUBJECTS : B.WORK_SUBJECTS_EN };

export const MOCK_CATEGORIES: MockCategory[] = [
  { name: "Facturas", color: "amber", tags: ["receipt", "bank"] },
  { name: "Clientes", color: "emerald", tags: ["client"] },
  { name: "Viajes", color: "cyan", tags: ["travel"] },
  { name: "Lecturas", color: "violet", tags: ["newsletter"] },
  { name: "Desarrollo", color: "brown", tags: ["dev"] },
];

/** mulberry32: tiny, fast, deterministic PRNG */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const DEFAULT_NOW = Date.UTC(2026, 9, 22, 15, 30);

export function generateDataset(options: GenerateOptions): MockDataset {
  const rand = prng(options.seed ?? 42);
  const now = options.now ?? DEFAULT_NOW;
  const spanDays = options.spanDays ?? 730;
  const demo = options.edition === "demo";
  // the categorization eval's families are Spanish and English mixed: the fixture's only
  if (demo && options.adversarial) throw new Error("the demo edition has no adversarial families (the fixture's, for the categorization eval)");
  const accounts = (demo ? DEMO_ACCOUNTS : ALL_ACCOUNTS).slice(0, Math.max(1, Math.min(options.accounts ?? 4, ALL_ACCOUNTS.length)));
  /** the fixture's accounts have no language: one mixed set for all */
  const poolsOf = (lang: B.Lang | undefined) => (lang ? DEMO_POOLS[lang] : FIXTURE_POOLS);
  const totalWeight = accounts.reduce((s, a) => s + a.weight, 0);

  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const chance = (p: number) => rand() < p;
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const fill = (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? k));
  const pickAccount = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < accounts.length; i++) {
      r -= accounts[i]!.weight;
      if (r <= 0) return i;
    }
    return accounts.length - 1;
  };
  const person = (lang?: B.Lang): Address => {
    const pools = poolsOf(lang);
    const first = pick(pools.first);
    const last = pick(pools.last);
    const local = `${first}.${last}`
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z.]/g, "");
    return { name: `${first} ${last}`, email: `${local || "user"}${chance(0.3) ? int(1, 99) : ""}@${pick(B.PERSONAL_DOMAINS)}` };
  };
  // Recent-skewed dates: most mail is from the last few months.
  const dateFor = () => now - Math.floor(Math.pow(rand(), 2.2) * spanDays * DAY) - int(0, 3_600_000);

  // Stable pools so senders repeat (needed for suggestions and learned filters)
  const people = (lang?: B.Lang) => {
    const friends = Array.from({ length: 40 }, () => person(lang));
    const coworkers = Array.from({ length: 18 }, () => {
      const p = person(lang);
      return { name: p.name, email: p.email.replace(/@.*/, "@acme.studio") };
    });
    return { friends, coworkers };
  };
  // the demo's: one set per language, so nobody on an English account writes on the Spanish one
  const circles: Partial<Record<B.Lang | "mixed", ReturnType<typeof people>>> = demo ? { en: people("en"), es: people("es") } : { mixed: people() };
  const circleOf = (lang: B.Lang | undefined) => circles[lang ?? "mixed"]!;

  const messages: MockMessage[] = [];
  let msgCounter = 0;
  let threadCounter = 0;

  const bodyScale = Math.max(1, options.bodyScale ?? 1);
  const sentences = (lang: B.Lang, n: number, list = voice(lang, demo).sentences) => Array.from({ length: n * bodyScale }, () => pick(list)).join(" ");

  type Draft = Omit<MockMessage, "accountIndex" | "providerMsgId" | "providerThreadId" | "rfcMessageId" | "inReplyTo" | "references" | "snippet" | "bodyState" | "size" | "isDraft" | "tags" | "family">;
  const emit = (drafts: readonly Draft[], accountIndex: number, threadKey: string, providerThreadId: string | null, family?: AdversarialFamily) => {
    const tags: ThreadTag[] = family ? [...FAMILY_TAGS[family]] : [...new Set(drafts.map((d) => d.tag))];
    let prevId: string | null = null;
    const refs: string[] = [];
    for (const d of drafts) {
      const id = ++msgCounter;
      const rfcMessageId = `${threadKey}.${id}@mock.terno`;
      messages.push({
        ...d,
        tags,
        ...(family ? { family } : {}),
        accountIndex,
        providerMsgId: `m${id}`,
        providerThreadId,
        rfcMessageId,
        inReplyTo: prevId,
        references: [...refs],
        snippet: "",
        bodyState: "full",
        isDraft: false,
        size: d.bodyText.length + (d.bodyHtml?.length ?? 0) + d.attachments.reduce((s, a) => s + a.size, 0),
      });
      refs.push(rfcMessageId);
      prevId = rfcMessageId;
    }
  };

  /** Plan 289: the demo's English notices (the fixture's English ones are a few words: "Order 123 shipped"). */
  const englishNotice = (src: B.NotificationSource, n: number, amount: string, coworkers: readonly Address[]): { tag: ThreadTag; subject: string; body: string; attach: boolean } => {
    switch (src.kind) {
      case "receipt":
        return { tag: "receipt", subject: `Your receipt from ${src.name} · $${amount}`, body: `Thanks for your order. Total: $${amount}. Invoice ${n} is ready in your account.`, attach: chance(0.6) };
      case "shipping":
        return { tag: "shipping", subject: `Your order ${n} ${pick(["has shipped", "is on its way", "was delivered"])}`, body: `Your package (tracking number 1Z${n}${int(10, 99)}) will arrive soon. You can track it in the app.`, attach: false };
      case "bank": {
        const subject = pick([`A charge of $${amount} on your card`, `Your ${pick(["January", "February", "March", "April", "May", "June"])} statement is ready`, "Transfer received"]);
        return { tag: "bank", subject, body: `A transaction of $${amount} was made on your account. If you don't recognize it, contact us.`, attach: subject.includes("statement") };
      }
      case "dev": {
        const repo = src.listId?.split(".")[0] ?? "web";
        const pr = int(100, 4000);
        const subject = src.name === "GitHub" ? `[acme/${repo}] ${pick(["Fix flaky test in checkout", "Add search index for threads", "Bump dependencies", "Refactor sync engine", "Improve keyboard navigation"])} (#${pr})` : `[ACM-${pr}] ${pick(["Search is slow on large inboxes", "Crash when opening attachment", "Polish empty states", "Dark mode contrast"])}`;
        return { tag: "dev", subject, body: `${pick(coworkers).name} ${pick(["commented", "approved these changes", "requested changes", "merged"])}: ${sentences("en", 2)}`, attach: false };
      }
      case "travel":
        return { tag: "travel", subject: `Your ${pick(["flight", "booking", "trip"])} to ${pick(["Lisbon", "Chicago", "Vancouver", "Tokyo", "Denver", "London"])} is confirmed · ${n}`, body: `Booking ${n} is confirmed. Show your boarding pass at the airport.`, attach: chance(0.5) };
      case "calendar":
        return { tag: "calendar", subject: `Invitation: ${pick(["Weekly review", "1:1 with Emma", "Client demo", "Q4 planning"])} @ ${pick(["Mon", "Tue", "Wed", "Thu", "Fri"])} ${int(9, 18)}:00`, body: "You have been invited to an event. Going? Yes · Maybe · No", attach: false };
    }
  };

  for (let t = 0; t < options.threads; t++) {
    const accountIndex = pickAccount();
    const account = accounts[accountIndex]!;
    const pools = poolsOf(account.lang);
    const { friends, coworkers } = circleOf(account.lang);
    const me: Address = { name: account.ownerName, email: account.email };
    const threadKey = `t${++threadCounter}`;
    const providerThreadId = account.kind === "gmail" ? `gth-${threadKey}` : null;
    const roll = rand();
    const baseDate = dateFor();
    const ageDays = (now - baseDate) / DAY;
    // newer mail is more likely unread and in the inbox
    const inInboxBase = ageDays < 21 ? chance(0.75) : ageDays < 120 ? chance(0.25) : chance(0.05);

    const drafts: Draft[] = [];
    const base = {
      cc: [] as Address[],
      bcc: [] as Address[],
      bodyHtml: null as string | null,
      listId: null as string | null,
      bulk: false,
      isStarred: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      attachments: [] as MockMessage["attachments"],
    };

    if (roll < 0.26) {
      const nl = pick(pools.newsletters);
      const topic = pick(nl.topics);
      const subject = fill(pick(nl.subjects), { topic, n: int(200, 720), product: "Pixel Fold", thing: "escritorio" });
      const intro = nl.lang === "es" ? `Esta semana hablamos de ${topic}.` : `This week: ${topic}.`;
      // the demo's say what a newsletter says; the fixture's borrow the conversations' sentences
      const lines = demo ? B.NEWSLETTER_LINES[nl.lang] : undefined;
      const body = `${intro} ${sentences(nl.lang, int(3, 7), lines)}\n\n${nl.lang === "es" ? "Darse de baja" : "Unsubscribe"}: https://${nl.listId}/u`;
      drafts.push({
        ...base,
        tag: "newsletter",
        from: { name: nl.name, email: nl.email },
        to: [me],
        subject,
        date: baseDate,
        bodyText: body,
        bodyHtml: `<div style="font-family:Georgia,serif;max-width:600px;margin:auto"><h1 style="font-size:22px">${escapeHtml(subject)}</h1><p>${escapeHtml(intro)}</p><p>${escapeHtml(sentences(nl.lang, 3, lines))}</p><img src="https://${nl.listId}/pixel.gif" width="1" height="1" alt=""><p style="color:#888;font-size:12px"><a href="https://${nl.listId}/u">${nl.lang === "es" ? "Darse de baja" : "Unsubscribe"}</a></p></div>`,
        listId: nl.listId,
        bulk: true,
        unsubscribe: { mailto: `mailto:unsubscribe@${nl.listId}?subject=unsubscribe` },
        isRead: ageDays > 7 || chance(0.4),
        inInbox: inInboxBase && chance(0.7),
        isSent: false,
      });
    } else if (roll < 0.52) {
      const src = pick(pools.notifiers);
      const n = int(1000, 99999);
      const amount = (int(80, 25000) + int(0, 99) / 100).toFixed(2);
      const es = src.lang === "es";
      let subject: string;
      let body: string;
      let tag: ThreadTag;
      let attach = false;
      // the demo's English accounts read proper English notices; the rest (the fixture, the Spanish account) as before
      if (demo && !es) ({ tag, subject, body, attach } = englishNotice(src, n, amount, coworkers));
      else switch (src.kind) {
        case "receipt":
          tag = "receipt";
          subject = es ? `Tu recibo de ${src.name} · $${amount} MXN` : `Your receipt from ${src.name} #${n}`;
          body = es ? `Gracias por tu compra. Total: $${amount} MXN. Factura ${n} disponible.` : `Thanks for your payment. Amount: $${amount}. Invoice #${n}.`;
          attach = chance(0.6);
          break;
        case "shipping":
          tag = "shipping";
          subject = es ? `Tu pedido ${n} ${pick(["ha sido enviado", "está en camino", "fue entregado"])}` : `Order ${n} shipped`;
          body = es ? `Tu paquete con número de guía MX${n}${int(10, 99)} llegará pronto. Puedes rastrearlo en la app.` : `Track your package MX${n}.`;
          break;
        case "bank":
          tag = "bank";
          subject = es ? pick([`Cargo por $${amount} en tu tarjeta`, `Tu estado de cuenta de ${pick(["enero", "febrero", "marzo", "abril", "mayo", "junio"])} está listo`, "Transferencia recibida"]) : "Account alert";
          body = es ? `Se realizó un movimiento por $${amount} MXN. Si no reconoces este cargo, comunícate con nosotros.` : `A transaction of $${amount} was made.`;
          attach = subject.includes("estado de cuenta");
          break;
        case "dev": {
          tag = "dev";
          const repo = src.listId?.split(".")[0] ?? "web";
          const pr = int(100, 4000);
          subject = src.name === "GitHub" ? `[acme/${repo}] ${pick(["Fix flaky test in checkout", "Add search index for threads", "Bump dependencies", "Refactor sync engine", "Improve keyboard navigation"])} (#${pr})` : `[ACM-${pr}] ${pick(["Search is slow on large inboxes", "Crash when opening attachment", "Polish empty states", "Dark mode contrast"])}`;
          body = `${pick(coworkers).name} ${pick(["commented", "approved these changes", "requested changes", "merged"])}: ${sentences("en", 2)}`;
          break;
        }
        case "travel":
          tag = "travel";
          subject = es ? `Confirmación de tu ${pick(["vuelo", "reservación", "viaje"])} a ${pick(["Oaxaca", "Madrid", "Bogotá", "Lima", "Cancún", "Tokio"])} · ${n}` : `Your trip confirmation ${n}`;
          body = es ? `Tu reservación ${n} está confirmada. Presenta tu pase de abordar en el aeropuerto.` : `Booking ${n} confirmed.`;
          attach = chance(0.5);
          break;
        case "calendar":
          tag = "calendar";
          subject = `Invitación: ${pick(["Revisión semanal", "1:1 con Lucía", "Demo con cliente", "Planeación Q4"])} @ ${pick(["lun", "mar", "mié", "jue", "vie"])} ${int(9, 18)}:00`;
          body = "Has sido invitado a un evento. Responde: Sí · Quizás · No";
          break;
      }
      // Batches of notifications often share the exact same timestamp.
      drafts.push({
        ...base,
        tag,
        from: { name: src.name, email: src.email },
        to: [me],
        subject,
        date: baseDate - (baseDate % 60_000),
        bodyText: body,
        listId: src.listId,
        // calendar invitations come without bulk headers (their address says what they are)
        bulk: src.kind !== "calendar",
        isRead: ageDays > 3 || chance(0.5),
        inInbox: inInboxBase,
        isSent: false,
        isStarred: chance(0.02),
        hasAttachments: attach,
        attachments: attach ? [{ ...pick(pools.attachments.slice(0, 1)), filename: `${es || !demo ? "factura" : "invoice"}-${n}.pdf`, size: int(40_000, 400_000) }] : [],
      });
    } else if (roll < 0.95) {
      // conversations: personal, work, client
      const kind: ThreadTag = rand() < 0.4 ? "personal" : rand() < 0.6 ? "work" : "client";
      // the demo's accounts each have one language; the fixture's threads toss for it
      const es = account.lang ? account.lang === "es" : chance(0.75);
      const v = voice(es ? "es" : "en", demo);
      const participants: Address[] =
        kind === "personal"
          ? [pick(friends)]
          : kind === "work"
            ? Array.from({ length: int(1, 4) }, () => pick(coworkers))
            : (() => {
                const c = pick(pools.clients);
                const p = person(account.lang);
                return [{ name: `${p.name} (${c.name})`, email: `${p.email.split("@")[0]}@${c.domain}` }];
              })();
      const project = pick(pools.projects);
      const subject = kind === "personal" ? pick(pools.personalSubjects) : fill(pick(v.workSubjects), { project, n: int(1, 40) });
      // Long-tail thread lengths, a few very long work threads.
      const length = kind === "work" && chance(0.03) ? int(18, 40) : Math.max(1, Math.round(Math.pow(rand(), 2) * 7));
      let date = baseDate;
      let previousBody = "";
      const starred = chance(0.06);
      const trashed = chance(0.025);
      for (let i = 0; i < length; i++) {
        const fromMe = i > 0 && chance(0.45);
        const other = pick(participants);
        const from = fromMe ? me : other;
        const to = fromMe ? participants : [me, ...participants.filter((p) => p !== other)];
        const name = (fromMe ? other.name : me.name).split(" ")[0]!;
        const opener = fill(pick(v.openers), { name });
        const closer = pick(v.closers);
        const text = `${opener}\n\n${sentences(es ? "es" : "en", int(1, 4))}\n\n${closer}\n${from.name.split(" ")[0]}`;
        const quoted = previousBody ? `\n\n> ${previousBody.split("\n").slice(0, 4).join("\n> ")}` : "";
        const attach = chance(kind === "client" ? 0.25 : 0.08);
        const last = i === length - 1;
        drafts.push({
          ...base,
          tag: kind,
          from,
          to,
          cc: kind === "work" && chance(0.3) ? [pick(coworkers)] : [],
          subject: i === 0 ? subject : `${es ? "RE" : "Re"}: ${subject}`,
          date,
          bodyText: text + quoted,
          isRead: fromMe || !last || ageDays > 10 || chance(0.35),
          inInbox: !fromMe && inInboxBase,
          isSent: fromMe,
          isStarred: starred && last,
          isTrash: trashed,
          hasAttachments: attach,
          attachments: attach ? [{ ...pick(pools.attachments), filename: fill(pick(pools.attachments).filename, { n: int(1, 9) }), size: int(20_000, 3_000_000) }] : [],
        });
        previousBody = text;
        date += int(10, 60 * 24) * 60_000;
        // a conversation can't continue into the future: stop it here
        if (date > now) break;
      }
    } else {
      const s = pick(pools.spammers);
      drafts.push({
        ...base,
        tag: "spam",
        from: s,
        to: [me],
        subject: pick(pools.spamSubjects),
        date: baseDate,
        bodyText: pools.spamBody,
        isRead: false,
        inInbox: false,
        isSent: false,
        isSpam: true,
        bulk: true,
      });
    }

    emit(drafts, accountIndex, threadKey, providerThreadId);
  }

  if (options.adversarial) {
    const o = options.adversarial === true ? {} : options.adversarial;
    const r = prng((options.seed ?? 42) ^ 0x5bd1e995);
    const ctx = {
      pick: <T,>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!,
      int: (min: number, max: number) => min + Math.floor(r() * (max - min + 1)),
      chance: (p: number) => r() < p,
      friends: circleOf(accounts[0]!.lang).friends,
      clients: B.CLIENT_COMPANIES,
      projects: B.PROJECT_WORDS,
      person: () => {
        const first = ctx.pick(B.FIRST_NAMES);
        const last = ctx.pick(B.LAST_NAMES);
        const local = `${first}.${last}`.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z.]/g, "");
        return { name: `${first} ${last}`, email: `${local || "user"}@${ctx.pick(B.PERSONAL_DOMAINS)}` };
      },
    };
    for (const family of FAMILIES) {
      const n = Math.max(3, Math.round(options.threads * FAMILY_SHARE[family]));
      for (let i = 0; i < n; i++) {
        const accountIndex = Math.floor(r() * accounts.length);
        const account = accounts[accountIndex]!;
        const me: Address = { name: account.ownerName, email: account.email };
        const threadKey = `t${++threadCounter}`;
        const after = family === "new-receipt" ? Math.max(o.newAfter ?? now - 18 * DAY, o.coldAfter ?? 0) : o.coldAfter;
        let date = after !== undefined ? after + Math.floor(r() * (now - after)) : now - Math.floor(Math.pow(r(), 2.2) * spanDays * DAY) - ctx.int(0, 3_600_000);
        const ageDays = (now - date) / DAY;
        const inInbox = ageDays < 21 ? ctx.chance(0.75) : ageDays < 120 ? ctx.chance(0.25) : ctx.chance(0.05);
        const drafts: Draft[] = [];
        for (const m of familyThread(family, ctx)) {
          drafts.push(familyDraft(m, me, date, inInbox, ageDays, FAMILY_TAGS[family][0]));
          date += ctx.int(30, 600) * 60_000;
          if (date > now) break;
        }
        emit(drafts, accountIndex, threadKey, account.kind === "gmail" ? `gth-${threadKey}` : null, family);
      }
    }
  }
  placeInFolders(accounts, messages);
  placeInTabs(accounts, messages);
  return { accounts, categories: demo ? DEMO_CATEGORIES : MOCK_CATEGORIES, messages };
}

function familyDraft(m: FamilyMessage, me: Address, date: number, inInbox: boolean, ageDays: number, tag: ThreadTag) {
  return {
    tag,
    from: m.fromMe ? me : m.from,
    to: m.fromMe ? [m.from] : [me],
    cc: [] as Address[],
    bcc: [] as Address[],
    subject: m.subject,
    date,
    bodyText: m.bodyText,
    bodyHtml: null,
    listId: m.listId,
    bulk: m.listId !== null,
    isRead: m.fromMe || ageDays > 7,
    isStarred: false,
    inInbox: !m.fromMe && !m.isSpam && inInbox,
    isSent: m.fromMe,
    isTrash: false,
    isSpam: m.isSpam,
    hasAttachments: m.attachments.length > 0,
    attachments: m.attachments,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** FNV-1a: a stable share of threads, without touching the dataset's random stream (every other value stays as it was). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Plan 86: Gmail's category on what others send (yours carry none), after the folders' labels: promotions apart, the rest Primary. */
function placeInTabs(accounts: readonly MockAccount[], messages: MockMessage[]): void {
  for (const m of messages) {
    if (accounts[m.accountIndex]!.kind !== "gmail" || m.isSent) continue;
    const category = m.tag === "promo" ? "CATEGORY_PROMOTIONS" : "CATEGORY_PERSONAL";
    m.gmailLabels = [...(m.gmailLabels ?? []), category];
  }
}

/**
 * Plan 68: a third of the threads whose tags a folder takes are in it, whole: Gmail labels on every message,
 * IMAP locations in the folder (beside wherever else the message is).
 */
function placeInFolders(accounts: readonly MockAccount[], messages: MockMessage[]): void {
  messages.forEach((m, i) => {
    const folders = accounts[m.accountIndex]?.folders ?? [];
    const thread = m.rfcMessageId.split(".")[0]!;
    const keys = folders.filter((f) => f.selectable && f.tags.some((t) => m.tags.includes(t)) && hash(`${thread}:${f.key}`) % 3 === 0).map((f) => f.key);
    if (!keys.length) return;
    if (accounts[m.accountIndex]!.kind === "gmail") m.gmailLabels = keys;
    else m.locations = keys.map((mailbox) => ({ mailbox, uidvalidity: 1, uid: i + 1, flags: m.isRead ? ["\\Seen"] : [] }));
  });
}

/**
 * Plan 289: what only the demo's Spanish account says: its people's names (whole, and every Spanish first name), its
 * subjects and its folders. The site's pictures refuse a frame that paints any of them.
 */
export function demoSpanishWords(data: MockDataset = generateDataset(DEMO_DATASET)): string[] {
  const of = (index: (i: number) => boolean) => {
    const words = new Set<string>();
    data.accounts.forEach((a, i) => index(i) && a.folders?.forEach((f) => f.path.forEach((part) => words.add(part))));
    for (const m of data.messages) {
      if (!index(m.accountIndex)) continue;
      words.add(m.subject.replace(/^(re|RE): /, ""));
      for (const a of [m.from, ...m.to, ...m.cc]) if (!data.accounts.some((own) => own.email === a.email)) words.add(a.name);
    }
    return words;
  };
  const spanish = of((i) => i === DEMO_SPANISH_ACCOUNT);
  for (const name of B.ES_FIRST_NAMES) spanish.add(name);
  // what the English accounts say too (Google Calendar, Uber Receipts) isn't Spanish, nor is a word with no letter ("2026")
  const english = of((i) => i !== DEMO_SPANISH_ACCOUNT);
  return [...spanish].filter((w) => /\p{L}/u.test(w) && !english.has(w));
}
