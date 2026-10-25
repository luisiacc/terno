import type { Address } from "@terno/core";
import type { MockAccount, MockDataset, MockMessage } from "./generate";

/**
 * A large mailbox for autocomplete's gates (plan 18): hundreds of thousands
 * of messages among a hundred thousand or more distinct people (every one
 * appears at least once; the rest follows a skewed, Zipf-like popularity),
 * names with accents, hyphens, apostrophes and CJK, and sent mail whose text
 * repeats a few habits ("Let me know if you have any questions.") among
 * filler and quotes. Fast to generate and deterministic.
 */
export interface ContactsDatasetOptions {
  messages: number;
  contacts: number;
  seed?: number;
  now?: number;
  /** share of messages the owner sent */
  sentShare?: number;
  spanDays?: number;
  /** characters of filler in each sent body (besides the habits and a quote) */
  bodyChars?: number;
}

const FIRST = ["Ana", "Andrés", "Arjun", "Beatriz", "Bob", "Camila", "Carlos", "Chen", "Daniela", "Diego", "Élodie", "Emma", "Fátima", "Felipe", "Gabriel", "Hana", "Hiroshi", "Iván", "Isabel", "Jean-Luc", "José", "Julia", "Kenji", "Laura", "Lucía", "Luz", "María", "Mateo", "Mei", "Nuria", "Olga", "Óscar", "Priya", "Rafael", "Raúl", "Sara", "Sofía", "Tomás", "Úrsula", "Valentina", "Wei", "Xiomara", "Yuki", "Zoë", "王小明", "李娜", "김민수", "さくら"];
const LAST = ["García", "López", "Patel", "Smith", "Müller", "Nguyen", "Rossi", "Kim", "Silva", "Fernández", "O'Brien", "Núñez", "Wang", "Sato", "Dubois", "Kowalski", "Ivanova", "Okafor", "Haddad", "Jensen", "Moreau", "Novak", "Castillo", "Ríos", "Ibáñez", "Schmidt", "Tanaka", "Andersson", "Costa", "Mendoza"];
const DOMAINS = ["gmail.com", "outlook.com", "icloud.com", "yahoo.com", "acme.studio", "orbita.dev", "lopez.mx", "univ.edu", "nube.io", "fabrica.cl", "zentrix.dev", "mail.ru", "proton.me"];
const HABITS_EN = ["Let me know if you have any questions.", "Thanks for the quick reply.", "I hope you're doing well.", "Sounds good to me.", "Please find the document attached.", "Talk soon,"];
const HABITS_ES = ["Quedo atento a tus comentarios.", "Gracias por la respuesta tan rápida.", "Espero que estés muy bien.", "Te comparto el documento adjunto.", "Saludos,"];
const FILLER = "the project timeline budget review meeting next week client proposal draft numbers update schedule team feedback design launch plan report quarter".split(" ");
const FILLER_ES = "el proyecto calendario presupuesto revisión reunión semana cliente propuesta borrador números equipo diseño lanzamiento plan informe trimestre".split(" ");

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

const ascii = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The people of the dataset, in a stable order (index i is the i-th most popular). */
export function contactPeople(n: number, seed = 1): Address[] {
  const rand = prng(seed);
  const people: Address[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)]!;
    const last = LAST[Math.floor(rand() * LAST.length)]!;
    const local = `${ascii(first) || "p"}.${ascii(last) || "x"}${i}`;
    const domain = DOMAINS[Math.floor(rand() * DOMAINS.length)]!;
    // a tenth come without a display name
    people.push({ name: rand() < 0.1 ? "" : `${first} ${last}`, email: `${local}@${domain}` });
  }
  return people;
}

/** A sent body: greeting, filler with one or two habits, a sign-off, and a quote of what came before. */
export function sentBody(rand: () => number, to: Address, es: boolean, chars: number): string {
  const name = to.name.split(" ")[0] || "there";
  const habits = es ? HABITS_ES : HABITS_EN;
  const filler = es ? FILLER_ES : FILLER;
  const words: string[] = [];
  let size = 0;
  while (size < chars) {
    const w = filler[Math.floor(rand() * filler.length)]!;
    words.push(w);
    size += w.length + 1;
  }
  const middle = `${words.join(" ")}.`;
  const habit = habits[Math.floor(Math.pow(rand(), 2) * habits.length)]!;
  const greeting = es ? `Hola ${name},` : `Hi ${name},`;
  const signoff = es ? "Saludos,\nLuis" : "Best,\nLuis";
  const quote = rand() < 0.6 ? `\n\n${es ? "El lunes, " + name + " escribió:" : "On Monday, " + name + " wrote:"}\n> ${filler.slice(0, 8).join(" ")}\n> ${filler.slice(8, 14).join(" ")}` : "";
  return `${greeting}\n\n${middle} ${habit}\n\n${signoff}${quote}`;
}

export const CONTACTS_ACCOUNT: MockAccount = { kind: "imap", email: "luis@cordero.dev", displayName: "Work", color: "indigo", ownerName: "Luis Cordero", weight: 1 };

/** The dataset's messages in pages, generated as they are consumed (a build reads a store page by page). */
export function* contactsPages(o: ContactsDatasetOptions, pageSize = 500, people = contactPeople(o.contacts, (o.seed ?? 7) ^ 0x9e37)): Generator<MockMessage[]> {
  const rand = prng(o.seed ?? 7);
  const now = o.now ?? Date.UTC(2026, 9, 22, 15, 30);
  const span = (o.spanDays ?? 1500) * 86_400_000;
  const sentShare = o.sentShare ?? 0.35;
  const bodyChars = o.bodyChars ?? 160;
  const me: Address = { name: CONTACTS_ACCOUNT.ownerName, email: CONTACTS_ACCOUNT.email };
  const pick = () => people[Math.floor(Math.pow(rand(), 2.4) * people.length)]!;
  let page: MockMessage[] = [];
  for (let i = 0; i < o.messages; i++) {
    // every person once (in order), then by popularity
    const main = i < people.length ? people[i]! : pick();
    const sent = rand() < sentShare;
    const others = rand() < 0.25 ? [pick()] : [];
    const es = rand() < 0.4;
    const date = now - Math.floor(Math.pow(rand(), 1.5) * span);
    page.push({
      accountIndex: 0,
      providerMsgId: `ac${i}`,
      providerThreadId: null,
      rfcMessageId: `<ac${i}@perf>`,
      inReplyTo: null,
      references: [],
      from: sent ? me : main,
      to: sent ? [main, ...others] : [me],
      cc: sent ? [] : others,
      bcc: [],
      subject: `Message ${i}`,
      date,
      snippet: "",
      bodyText: sent ? sentBody(rand, main, es, bodyChars) : "Short note.",
      bodyHtml: null,
      bodyState: "full",
      listId: null,
      isRead: true,
      isStarred: false,
      inInbox: !sent,
      isSent: sent,
      isDraft: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      size: 1000,
      attachments: [],
      tag: "personal",
      tags: ["personal"],
    });
    if (page.length === pageSize) {
      yield page;
      page = [];
    }
  }
  if (page.length) yield page;
}

export function generateContactsDataset(o: ContactsDatasetOptions): MockDataset {
  const messages: MockMessage[] = [];
  for (const page of contactsPages(o, 5000)) for (const m of page) messages.push(m);
  return { accounts: [CONTACTS_ACCOUNT], categories: [], messages };
}
