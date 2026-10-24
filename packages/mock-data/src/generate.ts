import type { Address, CategoryColor } from "@terno/core";
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
}

export type ThreadTag = "newsletter" | "receipt" | "shipping" | "bank" | "dev" | "travel" | "calendar" | "work" | "client" | "personal" | "spam" | "promo" | "phish";

export interface MockAccount {
  kind: "imap" | "gmail";
  email: string;
  displayName: string;
  color: string;
  ownerName: string;
  /** relative share of threads (skewed on purpose) */
  weight: number;
}

export interface MockCategory {
  name: string;
  color: CategoryColor;
  tags: ThreadTag[];
}

export interface GenerateOptions {
  seed?: number;
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

const ALL_ACCOUNTS: MockAccount[] = [
  { kind: "gmail", email: "luis.cordero@gmail.com", displayName: "Personal", color: "indigo", ownerName: "Luis Cordero", weight: 0.32 },
  { kind: "gmail", email: "luis@acme.studio", displayName: "Acme Studio", color: "emerald", ownerName: "Luis Carlos Cordero", weight: 0.3 },
  { kind: "imap", email: "hola@luiscordero.dev", displayName: "Freelance", color: "amber", ownerName: "Luis Cordero", weight: 0.14 },
  { kind: "imap", email: "lccordero@icloud.com", displayName: "iCloud", color: "cyan", ownerName: "Luis Cordero", weight: 0.08 },
  { kind: "gmail", email: "luis@orbitalabs.dev", displayName: "Orbita Labs", color: "violet", ownerName: "Luis Cordero", weight: 0.07 },
  { kind: "imap", email: "l.cordero@universidad.edu.mx", displayName: "Universidad", color: "rose", ownerName: "Luis Cordero Peña", weight: 0.04 },
  { kind: "imap", email: "luiscp@hotmail.com", displayName: "Hotmail (viejo)", color: "slate", ownerName: "Luis C.", weight: 0.03 },
  { kind: "gmail", email: "compras.luis@gmail.com", displayName: "Compras", color: "lime", ownerName: "Luis Cordero", weight: 0.02 },
];

export const MOCK_CATEGORIES: MockCategory[] = [
  { name: "Facturas", color: "amber", tags: ["receipt", "bank"] },
  { name: "Clientes", color: "emerald", tags: ["client"] },
  { name: "Viajes", color: "cyan", tags: ["travel"] },
  { name: "Lecturas", color: "violet", tags: ["newsletter"] },
  { name: "Desarrollo", color: "indigo", tags: ["dev"] },
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
  const accounts = ALL_ACCOUNTS.slice(0, Math.max(1, Math.min(options.accounts ?? 4, ALL_ACCOUNTS.length)));
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
  const person = (): Address => {
    const first = pick(B.FIRST_NAMES);
    const last = pick(B.LAST_NAMES);
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
  const friends = Array.from({ length: 40 }, person);
  const coworkers = Array.from({ length: 18 }, () => {
    const p = person();
    return { name: p.name, email: p.email.replace(/@.*/, "@acme.studio") };
  });

  const messages: MockMessage[] = [];
  let msgCounter = 0;
  let threadCounter = 0;

  const bodyScale = Math.max(1, options.bodyScale ?? 1);
  const sentences = (lang: "es" | "en", n: number) =>
    Array.from({ length: n * bodyScale }, () => pick(lang === "es" ? B.SENTENCES_ES : B.SENTENCES_EN)).join(" ");

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

  for (let t = 0; t < options.threads; t++) {
    const accountIndex = pickAccount();
    const account = accounts[accountIndex]!;
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
      isStarred: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      attachments: [] as MockMessage["attachments"],
    };

    if (roll < 0.26) {
      const nl = pick(B.NEWSLETTERS);
      const topic = pick(nl.topics);
      const subject = fill(pick(nl.subjects), { topic, n: int(200, 720), product: "Pixel Fold", thing: "escritorio" });
      const intro = nl.lang === "es" ? `Esta semana hablamos de ${topic}.` : `This week: ${topic}.`;
      const body = `${intro} ${sentences(nl.lang, int(3, 7))}\n\n${nl.lang === "es" ? "Darse de baja" : "Unsubscribe"}: https://${nl.listId}/u`;
      drafts.push({
        ...base,
        tag: "newsletter",
        from: { name: nl.name, email: nl.email },
        to: [me],
        subject,
        date: baseDate,
        bodyText: body,
        bodyHtml: `<div style="font-family:Georgia,serif;max-width:600px;margin:auto"><h1 style="font-size:22px">${escapeHtml(subject)}</h1><p>${escapeHtml(intro)}</p><p>${escapeHtml(sentences(nl.lang, 3))}</p><img src="https://${nl.listId}/pixel.gif" width="1" height="1" alt=""><p style="color:#888;font-size:12px"><a href="https://${nl.listId}/u">${nl.lang === "es" ? "Darse de baja" : "Unsubscribe"}</a></p></div>`,
        listId: nl.listId,
        isRead: ageDays > 7 || chance(0.4),
        inInbox: inInboxBase && chance(0.7),
        isSent: false,
      });
    } else if (roll < 0.52) {
      const src = pick(B.NOTIFIERS);
      const n = int(1000, 99999);
      const amount = (int(80, 25000) + int(0, 99) / 100).toFixed(2);
      const es = src.lang === "es";
      let subject: string;
      let body: string;
      let tag: ThreadTag;
      let attach = false;
      switch (src.kind) {
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
        isRead: ageDays > 3 || chance(0.5),
        inInbox: inInboxBase,
        isSent: false,
        isStarred: chance(0.02),
        hasAttachments: attach,
        attachments: attach ? [{ ...pick(B.ATTACHMENT_NAMES.slice(0, 1)), filename: `factura-${n}.pdf`, size: int(40_000, 400_000) }] : [],
      });
    } else if (roll < 0.95) {
      // conversations: personal, work, client
      const kind: ThreadTag = rand() < 0.4 ? "personal" : rand() < 0.6 ? "work" : "client";
      const es = chance(0.75);
      const participants: Address[] =
        kind === "personal"
          ? [pick(friends)]
          : kind === "work"
            ? Array.from({ length: int(1, 4) }, () => pick(coworkers))
            : (() => {
                const c = pick(B.CLIENT_COMPANIES);
                const p = person();
                return [{ name: `${p.name} (${c.name})`, email: `${p.email.split("@")[0]}@${c.domain}` }];
              })();
      const project = pick(B.PROJECT_WORDS);
      const subject =
        kind === "personal"
          ? pick(B.PERSONAL_SUBJECTS)
          : fill(pick(es ? B.WORK_SUBJECTS_ES : B.WORK_SUBJECTS_EN), { project, n: int(1, 40) });
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
        const opener = fill(pick(es ? B.OPENERS_ES : B.OPENERS_EN), { name });
        const closer = pick(es ? B.CLOSERS_ES : B.CLOSERS_EN);
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
          attachments: attach ? [{ ...pick(B.ATTACHMENT_NAMES), filename: fill(pick(B.ATTACHMENT_NAMES).filename, { n: int(1, 9) }), size: int(20_000, 3_000_000) }] : [],
        });
        previousBody = text;
        date += int(10, 60 * 24) * 60_000;
        // a conversation can't continue into the future: stop it here
        if (date > now) break;
      }
    } else {
      const s = pick(B.SPAMMERS);
      drafts.push({
        ...base,
        tag: "spam",
        from: s,
        to: [me],
        subject: pick(["¡¡Felicidades!! Has ganado un iPhone 17", "URGENT: claim your prize now", "💰 Gana $5,000 diarios desde casa", "Your account will be suspended"]),
        date: baseDate,
        bodyText: "Haz clic aquí para reclamar tu premio antes de que expire la oferta.",
        isRead: false,
        inInbox: false,
        isSent: false,
        isSpam: true,
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
      friends,
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
  return { accounts, categories: MOCK_CATEGORIES, messages };
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
