import type { Address } from "@terno/core";
import type { MockAccount, MockDataset, MockMessage } from "../generate";
import { foreignLinks, validateBulk, validateThreads, validateWorld, type Issue } from "./rules";
import type { AccountDef, BrandKind, BulkSlot, BulkSource, CorpusSources, Lang, MessageRecord, Person, SpamSource, StyleCard, ThreadRecord } from "./types";

/**
 * Plan 292: the written demo mailbox as the dataset `store.dev.seed` takes. Pure and deterministic: the same sources give
 * the same messages, byte for byte. Validates everything first (revision 2) and throws before anything is written.
 */
export function demoCorpusDataset(src: CorpusSources): MockDataset {
  const issues = [...validateWorld(src.world), ...validateThreads(src.world, src.threads, src.seeds ?? [], src.lists), ...validateBulk(src.world, src.bulk, src.spam)];
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new CorpusError(errors);
  const ctx = new Context(src);
  const messages = [...src.threads.flatMap((t) => ctx.thread(t)), ...src.bulk.flatMap((b) => ctx.bulk(b)), ...src.spam.map((s, i) => ctx.spam(s, i))];
  // revision 7: inserted in date order, so the newest mail has the highest ids (the digest walks them newest first)
  messages.sort((a, b) => a.date - b.date || a.providerMsgId.localeCompare(b.providerMsgId));
  ctx.placeImap(messages);
  // what the templates and forwards became, checked as it will be stored (Codex code review): ids unique, links inert
  const built = builtProblems(messages, Date.parse(src.world.anchor));
  if (built.length) throw new CorpusError(built);
  return {
    accounts: src.world.accounts.map(toAccount),
    categories: src.world.categories.map((c) => ({ ...c })),
    messages,
  };
}

/** The built messages as they'll be written: one row each (ids unique), nothing after the anchor, every link inert. */
export function builtProblems(messages: readonly MockMessage[], anchor: number): Issue[] {
  const out: Issue[] = [];
  const rfc = new Set<string>();
  const provider = new Set<string>();
  for (const m of messages) {
    const where = `${m.providerMsgId} (${m.subject})`;
    if (rfc.has(m.rfcMessageId)) out.push({ level: "error", where, message: `Message-ID ${m.rfcMessageId} twice` });
    rfc.add(m.rfcMessageId);
    const key = `${m.accountIndex}:${m.providerMsgId}`;
    if (provider.has(key)) out.push({ level: "error", where, message: "provider id twice on one account" });
    provider.add(key);
    if (m.date > anchor) out.push({ level: "error", where, message: "dated after the anchor" });
    for (const host of foreignLinks(`${m.bodyText}\n${m.bodyHtml ?? ""}`)) out.push({ level: "error", where, message: `link to ${host}` });
  }
  return out;
}

// no parameter properties here or below: scripts run this file under Node's type stripping
export class CorpusError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`the demo corpus has ${issues.length} errors, first: ${issues.slice(0, 5).map((i) => `${i.where}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MONTHS: Record<Lang, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};
const WEEKDAYS: Record<Lang, string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
};
const SHORT_WEEKDAYS: Record<Lang, string[]> = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] };
const SHORT_MONTHS: Record<Lang, string[]> = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"] };

function toAccount(a: AccountDef): MockAccount {
  return { kind: a.kind, email: a.email, displayName: a.displayName, color: a.color, ownerName: a.ownerName, weight: a.weight, folders: a.folders.map((f) => ({ ...f, path: [...f.path], tags: [...f.tags] })) };
}

/** FNV-1a, for stable choices that don't depend on order. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  // murmur3's finaliser: FNV alone barely moves the high bits for a different last character, so "slot:1" and
  // "slot:2" drew the same value
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const unit = (key: string) => hash(key) / 4294967296;

/** The wall clock in `zone` at `utc`, as fields. */
function zoned(utc: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(utc);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { year: Number(get("year")), month: Number(get("month")) - 1, day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}
/** The UTC instant of a wall-clock time in `zone`. */
function fromZoned(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (utc: number) => {
    const z = zoned(utc, zone);
    return Date.UTC(z.year, z.month, z.day, z.hour, z.minute) - Math.floor(utc / 60_000) * 60_000;
  };
  // twice: the offset at the wall time read as UTC can be the other side of a clock change (Codex code review); a wall
  // time the change skips lands an hour later, one it repeats on its first pass
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

/** "On Thu, 22 Oct 2026 at 09:14, Name <a@b> wrote:" in the replier's language, at the quoted message's local time. */
function attribution(lang: Lang, date: number, zone: string, who: Address): string {
  const z = zoned(date, zone);
  const time = `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
  return lang === "es"
    ? `El ${SHORT_WEEKDAYS.es[z.weekday]}, ${z.day} ${SHORT_MONTHS.es[z.month]} ${z.year} a las ${time}, ${who.name} <${who.email}> escribió:`
    : `On ${SHORT_WEEKDAYS.en[z.weekday]}, ${z.day} ${SHORT_MONTHS.en[z.month]} ${z.year} at ${time}, ${who.name} <${who.email}> wrote:`;
}
const quote = (text: string) => text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

const QUOTE_DEPTH = 4;

class Context {
  private readonly people = new Map<string, Person>();
  private readonly accounts: Map<string, { def: AccountDef; index: number }>;
  private readonly brands;
  private readonly anchor: number;
  /** IMAP folders a message is filed in, by provider id (human threads' own folder, a share of each brand's mail) */
  private readonly folders = new Map<string, string[]>();
  private readonly src: CorpusSources;

  constructor(src: CorpusSources) {
    this.src = src;
    for (const p of src.world.people) this.people.set(p.id, p);
    this.accounts = new Map(src.world.accounts.map((def, index) => [def.key, { def, index }]));
    this.brands = new Map(src.world.brands.map((b) => [b.id, b]));
    this.anchor = Date.parse(src.world.anchor);
  }

  private account(key: string) {
    const a = this.accounts.get(key);
    if (!a) throw new Error(`no account ${key}`);
    return a;
  }

  private addressOf(id: string, t: ThreadRecord, local: Map<string, Person>): Address {
    if (id === "me") {
      const a = this.account(t.account).def;
      return { name: a.ownerName, email: a.email };
    }
    if (id === "list") {
      const list = this.src.lists.find((l) => l.listId === t.listId);
      return list ? { name: list.name, email: list.address } : { name: "", email: `list@${t.listId}` };
    }
    const p = local.get(id) ?? this.people.get(id);
    if (!p) throw new Error(`${t.id}: no person ${id}`);
    return { name: p.name, email: p.email };
  }

  private styleOf(id: string, t: ThreadRecord, local: Map<string, Person>): { style: StyleCard; zone: string } {
    if (id === "me") return { style: this.src.world.owner.style[t.lang], zone: this.src.world.owner.timezone };
    const p = local.get(id) ?? this.people.get(id);
    return { style: p!.style, zone: p!.timezone };
  }

  private messageHost(from: Address): string {
    const domain = from.email.split("@")[1]!;
    return domain === "gmail.com" ? "mail.gmail.com" : domain;
  }

  /** A human thread's messages, with headers, quoted history and the account's labels. */
  thread(t: ThreadRecord): MockMessage[] {
    const { def, index } = this.account(t.account);
    const local = new Map((t.people ?? []).map((p) => [p.id, p]));
    const providerThreadId = def.kind === "gmail" ? `gth-${t.id}` : null;
    const out: MockMessage[] = [];
    const refs: string[] = [];
    const bodies: string[] = [];
    t.messages.forEach((m, i) => {
      const from = this.addressOf(m.from, t, local);
      const mine = m.from === "me";
      const date = Date.parse(m.date);
      const id = `${t.id}.${i + 1}.${hash(`${t.id}:${i}:${m.date}`).toString(36)}@${this.messageHost(from)}`;
      const body = this.body(m, i, t, local, bodies, out);
      bodies.push(body);
      const subject = m.subject ?? (i === 0 ? t.subject : `${t.lang === "es" ? "RE" : "Re"}: ${t.subject}`);
      const isRead = mine || m.read;
      const inInbox = !mine && t.state.inbox && !t.state.trash && !t.state.spam;
      const starred = Boolean(t.state.starred) && i === t.messages.length - 1;
      const attachments = (m.attachments ?? []).map((a) => ({ ...a }));
      const labels = def.kind === "gmail" ? this.gmailLabels(t, mine, isRead, inInbox, starred, "human") : undefined;
      if (def.kind === "imap" && t.folder) this.folders.set(`d-${t.id}-${i + 1}`, [t.folder]);
      out.push({
        accountIndex: index,
        providerMsgId: `d-${t.id}-${i + 1}`,
        providerThreadId,
        rfcMessageId: id,
        inReplyTo: refs.at(-1) ?? null,
        references: [...refs],
        from,
        to: m.to.map((r) => this.addressOf(r, t, local)),
        cc: (m.cc ?? []).map((r) => this.addressOf(r, t, local)),
        bcc: (m.bcc ?? []).map((r) => this.addressOf(r, t, local)),
        subject,
        date,
        snippet: m.text.replace(/\s+/g, " ").trim().slice(0, 140),
        bodyText: body,
        bodyHtml: null,
        bodyState: "full",
        listId: t.listId ?? null,
        bulk: false,
        isRead,
        isStarred: starred,
        inInbox,
        isSent: mine,
        isDraft: false,
        isTrash: Boolean(t.state.trash),
        isSpam: Boolean(t.state.spam),
        hasAttachments: attachments.length > 0,
        size: body.length + attachments.reduce((s, a) => s + a.size, 0),
        attachments,
        tag: t.tags[0]!,
        tags: [...t.tags],
        ...(labels ? { gmailLabels: labels } : {}),
      });
      refs.push(id);
    });
    return out;
  }

  /** What the sender typed, then the quoted or forwarded mail in their client's habit (capped at a few levels). */
  private body(m: MessageRecord, i: number, t: ThreadRecord, local: Map<string, Person>, bodies: string[], prior: MockMessage[]): string {
    const { style } = this.styleOf(m.from, t, local);
    const fwd = m.forward;
    if (fwd) {
      const block =
        fwd === true && i > 0
          ? { from: `${prior[i - 1]!.from.name} <${prior[i - 1]!.from.email}>`, date: this.longDate(prior[i - 1]!.date, t.lang), subject: prior[i - 1]!.subject, to: prior[i - 1]!.to.map((a) => `${a.name} <${a.email}>`).join(", "), text: t.messages[i - 1]!.text }
          : typeof fwd === "object"
            ? { from: fwd.from, date: this.longDate(Date.parse(fwd.date), t.lang), subject: fwd.subject, to: fwd.to ?? "", text: fwd.text }
            : null;
      if (block) {
        const head = t.lang === "es" ? ["---------- Mensaje reenviado ---------", `De: ${block.from}`, `Fecha: ${block.date}`, `Asunto: ${block.subject}`, `Para: ${block.to}`] : ["---------- Forwarded message ---------", `From: ${block.from}`, `Date: ${block.date}`, `Subject: ${block.subject}`, `To: ${block.to}`];
        return `${m.text}\n\n${head.join("\n")}\n\n${block.text}`;
      }
    }
    if (i === 0 || style.quoting === "none") return m.text;
    const prev = prior[i - 1]!;
    const prevBody = depth(bodies[i - 1]!) >= QUOTE_DEPTH ? t.messages[i - 1]!.text : bodies[i - 1]!;
    const prevZone = this.styleOf(t.messages[i - 1]!.from, t, local).zone;
    const quoted = `${attribution(t.lang, prev.date, prevZone, prev.from)}\n${quote(prevBody)}`;
    return style.quoting === "top" ? `${quoted}\n\n${m.text}` : `${m.text}\n\n${quoted}`;
  }

  private longDate(utc: number, lang: Lang): string {
    const z = zoned(utc, this.src.world.owner.timezone);
    const time = `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
    return lang === "es" ? `${WEEKDAYS.es[z.weekday]}, ${z.day} de ${MONTHS.es[z.month]} de ${z.year}, ${time}` : `${WEEKDAYS.en[z.weekday]}, ${z.day} ${MONTHS.en[z.month]} ${z.year} at ${time}`;
  }

  private gmailLabels(t: { folder?: string; id: string } | null, mine: boolean, read: boolean, inbox: boolean, starred: boolean, kind: "human" | BrandKind | "spam", folderKeys: string[] = []): string[] {
    const labels = [...folderKeys];
    if (t?.folder) labels.push(t.folder);
    if (kind === "spam") return [...labels, "SPAM", ...(read ? [] : ["UNREAD"])];
    if (inbox) labels.push("INBOX");
    if (mine) labels.push("SENT");
    if (!read) labels.push("UNREAD");
    if (starred) labels.push("STARRED");
    // plan 86: Gmail's tab on what others send; newsletters stay Primary so the digest reads them (revision 7)
    if (!mine) labels.push(kind === "promo" ? "CATEGORY_PROMOTIONS" : kind === "social" ? "CATEGORY_SOCIAL" : kind === "human" || kind === "newsletter" ? "CATEGORY_PERSONAL" : "CATEGORY_UPDATES");
    return labels;
  }

  /** A brand's machine mail on its schedule, filled from its templates. */
  bulk(b: BulkSource): MockMessage[] {
    const brand = this.brands.get(b.brand);
    if (!brand) throw new Error(`bulk/${b.brand}: no brand`);
    const { def, index } = this.account(b.account);
    const dates = this.schedule(b);
    const issues = b.issues ?? [];
    const out: MockMessage[] = [];
    // newest first, so the newest dates get the newest issues
    [...dates].reverse().forEach((date, n) => {
      const key = `${b.brand}:${b.account}:${date}`;
      const vars = this.builtins(date, brand.lang, b);
      let subject: string;
      let text: string;
      let html: string | undefined;
      let attachments: MockMessage["attachments"] = [];
      if (issues.length) {
        const issue = issues[n % issues.length]!;
        [subject, text, html] = [fill(issue.subject, vars), fill(issue.text, vars), issue.html && fill(issue.html, vars)];
      } else {
        const tpl = weightedPick(b.templates, unit(key));
        for (const [name, slot] of Object.entries(tpl.slots ?? {})) vars[name] = slotValue(slot, `${key}:${name}`, b.currency);
        [subject, text, html] = [fill(tpl.subject, vars), fill(tpl.text, vars), tpl.html && fill(tpl.html, vars)];
        attachments = (tpl.attachments ?? []).map((a) => ({ ...a, filename: fill(a.filename, vars) }));
      }
      const age = this.anchor - date;
      const { read, inbox } = bulkState(brand.kind, age, unit(`${key}:state`));
      const listed = brand.kind === "newsletter" || brand.kind === "promo" || brand.kind === "social";
      const folderKeys = def.folders.filter((f) => f.selectable && f.tags.includes(brand.tag) && hash(`${key}:${f.key}`) % 3 === 0).map((f) => f.key);
      out.push({
        accountIndex: index,
        providerMsgId: `b-${b.brand}-${b.account}-${date.toString(36)}`,
        providerThreadId: def.kind === "gmail" ? `gth-b-${b.brand}-${date.toString(36)}` : null,
        rfcMessageId: `${date.toString(36)}.${hash(key).toString(36)}@${brand.domain}`,
        inReplyTo: null,
        references: [],
        from: { name: brand.fromName, email: brand.fromEmail },
        to: [{ name: def.ownerName, email: def.email }],
        cc: [],
        bcc: [],
        subject,
        date,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 140),
        bodyText: text,
        bodyHtml: html ?? null,
        bodyState: "full",
        listId: brand.listId ?? null,
        bulk: true,
        ...(listed ? { unsubscribe: { mailto: `mailto:unsubscribe@${brand.domain}?subject=unsubscribe` } } : {}),
        isRead: read,
        isStarred: false,
        inInbox: inbox,
        isSent: false,
        isDraft: false,
        isTrash: false,
        isSpam: false,
        hasAttachments: attachments.length > 0,
        size: text.length + (html?.length ?? 0) + attachments.reduce((s, a) => s + a.size, 0),
        attachments,
        tag: brand.tag,
        tags: [brand.tag],
        ...(def.kind === "gmail" ? { gmailLabels: this.gmailLabels(null, false, read, inbox, false, brand.kind, folderKeys) } : {}),
      });
      if (def.kind === "imap" && folderKeys.length) this.folders.set(out.at(-1)!.providerMsgId, folderKeys);
    });
    return out;
  }

  spam(s: SpamSource, i: number): MockMessage {
    const { def, index } = this.account(s.account);
    const date = this.anchor - s.daysAgo * DAY - Math.floor(unit(`spam:${i}`) * 20 * HOUR);
    const read = unit(`spam:${i}:read`) < 0.2;
    return {
      accountIndex: index,
      providerMsgId: `s-${i + 1}`,
      providerThreadId: def.kind === "gmail" ? `gth-s-${i + 1}` : null,
      rfcMessageId: `spam.${i + 1}.${hash(s.subject).toString(36)}@${s.fromEmail.split("@")[1]}`,
      inReplyTo: null,
      references: [],
      from: { name: s.fromName, email: s.fromEmail },
      to: [{ name: "", email: def.email }],
      cc: [],
      bcc: [],
      subject: s.subject,
      date,
      snippet: s.text.replace(/\s+/g, " ").trim().slice(0, 140),
      bodyText: s.text,
      bodyHtml: s.html ?? null,
      bodyState: "full",
      listId: null,
      bulk: true,
      isRead: read,
      isStarred: false,
      inInbox: false,
      isSent: false,
      isDraft: false,
      isTrash: false,
      isSpam: true,
      hasAttachments: false,
      size: s.text.length + (s.html?.length ?? 0),
      attachments: [],
      tag: "spam",
      tags: ["spam"],
      ...(def.kind === "gmail" ? { gmailLabels: this.gmailLabels(null, false, read, false, false, "spam") } : {}),
    };
  }

  /** Every instant a brand mails, oldest first, inside its window and before the anchor. */
  private schedule(b: BulkSource): number[] {
    const s = b.schedule;
    const start = s.from ? Date.parse(s.from) : this.anchor - 730 * DAY;
    const end = Math.min(s.to ? Date.parse(s.to) + DAY : Infinity, this.anchor);
    const [hh, mm] = (s.at ?? "09:00").split(":").map(Number) as [number, number];
    const out: number[] = [];
    for (let day = start - (start % DAY); day < end + DAY; day += DAY) {
      const d = new Date(day);
      const [y, mo, dd, wd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()];
      const key = `${b.brand}:${b.account}:${y}-${mo}-${dd}`;
      let times: number[] = [];
      const at = (h: number, m: number) => fromZoned(y, mo, dd, h, m, s.zone);
      if (s.every === "daily") times = [at(hh, mm)];
      else if (s.every === "weekdays") times = wd > 0 && wd < 6 ? [at(hh, mm)] : [];
      else if (s.every === "weekly") times = wd === (s.day ?? 1) ? [at(hh, mm)] : [];
      // every other week, counted from Monday 1 January 2024 so a sender's weeks never shift with its window
      else if (s.every === "fortnightly") times = wd === (s.day ?? 1) && Math.floor((day - Date.UTC(2024, 0, 1)) / (7 * DAY)) % 2 === 0 ? [at(hh, mm)] : [];
      else if (s.every === "monthly") times = (s.nth ? wd === s.nth[1] && Math.ceil(dd / 7) === s.nth[0] : dd === (s.day ?? 1)) ? [at(hh, mm)] : [];
      else {
        const [lo, hi] = s.perWeek ?? [1, 3];
        const days = s.workdays ? 5 : 7;
        const perDay = s.workdays && (wd === 0 || wd === 6) ? 0 : (lo + unit(`${key}:rate`) * (hi - lo)) / days;
        const n = perDay >= 1 ? Math.floor(perDay) + (unit(`${key}:extra`) < perDay % 1 ? 1 : 0) : unit(`${key}:n`) < perDay ? 1 : 0;
        times = Array.from({ length: n }, (_, k) => at(8 + Math.floor(unit(`${key}:h${k}`) * 13), Math.floor(unit(`${key}:m${k}`) * 60)));
      }
      // the jitter first, then the bounds: nothing lands after the anchor
      for (const t of times.map((t) => t + Math.floor(unit(`${key}:${t}:s`) * 90) * 1000)) if (t >= start && t < end && t <= this.anchor) out.push(t);
    }
    // two sends on the same second would share their ids (both are made from the date): the later one moves a second
    out.sort((a, b2) => a - b2);
    for (let i = 1; i < out.length; i++) if (out[i]! <= out[i - 1]!) out[i] = out[i - 1]! + 1000;
    return out.filter((t) => t <= this.anchor);
  }

  private builtins(date: number, lang: Lang, b: BulkSource): Record<string, string> {
    const z = zoned(date, b.schedule.zone);
    return {
      date: lang === "es" ? `${z.day} de ${MONTHS.es[z.month]} de ${z.year}` : `${z.day} ${MONTHS.en[z.month]} ${z.year}`,
      time: `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`,
      weekday: WEEKDAYS[lang][z.weekday]!,
      month: MONTHS[lang][z.month]!,
      year: String(z.year),
      first: this.src.world.owner.name.split(" ")[0]!,
    };
  }

  /** Plan 68: IMAP locations for what's in a folder, UIDVALIDITY 1, UIDs in date order per account and mailbox. */
  placeImap(messages: MockMessage[]): void {
    const uids = new Map<string, number>();
    for (const m of messages) {
      const mailboxes = this.folders.get(m.providerMsgId);
      if (!mailboxes) continue;
      m.locations = mailboxes.map((mailbox) => {
        const k = `${m.accountIndex}:${mailbox}`;
        const uid = (uids.get(k) ?? 0) + 1;
        uids.set(k, uid);
        return { mailbox, uidvalidity: 1, uid, flags: m.isRead ? ["\\Seen"] : [] };
      });
    }
  }
}

const depth = (body: string) => Math.max(0, ...body.split("\n").map((l) => /^(>\s?)+/.exec(l)?.[0].replace(/\s/g, "").length ?? 0));

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => vars[k] ?? whole);
}

function weightedPick<T extends { weight?: number }>(list: readonly T[], r: number): T {
  const total = list.reduce((s, x) => s + (x.weight ?? 1), 0);
  let left = r * total;
  for (const x of list) if ((left -= x.weight ?? 1) <= 0) return x;
  return list.at(-1)!;
}

function slotValue(slot: BulkSlot, key: string, currency = "£"): string {
  const r = unit(key);
  if (Array.isArray(slot)) return slot[Math.floor(r * slot.length)] ?? "";
  if ("money" in slot) return `${currency}${(slot.money[0] + r * (slot.money[1] - slot.money[0])).toFixed(2)}`;
  if ("int" in slot) return String(slot.int[0] + Math.floor(r * (slot.int[1] - slot.int[0] + 1)));
  let i = 0;
  return slot.ref.replace(/[#?]/g, (c) => {
    const v = unit(`${key}:${i++}`);
    return c === "#" ? String(Math.floor(v * 10)) : String.fromCharCode(65 + Math.floor(v * 26));
  });
}

/** Read and Inbox by kind and age, as a tended mailbox looks: recent things waiting, old things filed. */
function bulkState(kind: BrandKind, age: number, r: number): { read: boolean; inbox: boolean } {
  const days = age / DAY;
  switch (kind) {
    case "newsletter":
      return days < 1 ? { read: false, inbox: true } : days < 7 ? { read: r < 0.4, inbox: r < 0.7 } : { read: r < 0.7, inbox: r < 0.08 };
    case "promo":
    case "social":
      return { read: r < 0.3, inbox: days < 7 ? r < 0.5 : r < 0.05 };
    case "dev":
    case "tool":
      return days < 2 ? { read: r < 0.4, inbox: r < 0.8 } : { read: r < 0.9, inbox: r < 0.04 };
    case "security":
      return { read: days > 1 || r < 0.5, inbox: days < 7 ? r < 0.6 : r < 0.03 };
    default:
      return days < 2 ? { read: r < 0.5, inbox: true } : { read: r < 0.95, inbox: r < 0.12 };
  }
}
