import type { Address, AttachmentInfo, MessageDetail } from "@terno/core";

/**
 * Plan 177: what a conversation of two or more messages says at its top: who's on it and every file in it. Pure, over the
 * messages the reader already holds; the components memoize on that array.
 */

export interface ThreadPerson {
  email: string;
  /** their full name, or the address when they gave none */
  name: string;
  /** what the chip says: their first name, the full name when another person shares it, the address without a name */
  short: string;
  /** they wrote a message here (not only written to) */
  wrote: boolean;
  /** the newest message they wrote, for the reader's avatar rules (plan 158) */
  lastSent: MessageDetail | null;
}

const fold = (email: string) => email.trim().toLowerCase();

/** a company's ending after its comma ("Acme, Inc."): a name, not "Surname, Given" */
const COMPANY = /^(inc|llc|ltd|plc|gmbh|ag|co|corp|s\.?a|s\.?l|s\.?a\.? de c\.?v|b\.?v|oy|ab|pty)\.?$/i;

/**
 * "Ana López (Acme)" → "Ana"; "García López, Ana" and "van der Meer, Jan" → the given name after the comma; "Acme, Inc." →
 * "Acme"; a name that is the address stays the address.
 */
export function firstName(name: string, email: string): string {
  const n = name.trim();
  if (!n || fold(n) === fold(email)) return email;
  const comma = n.indexOf(",");
  const after = comma > 0 ? n.slice(comma + 1).trim() : "";
  const given = after && !COMPANY.test(after) ? after : comma > 0 ? n.slice(0, comma) : n;
  return given.split(/\s+/)[0] ?? n;
}

/**
 * Everyone who wrote or was written to (from, to, cc), once each by case-folded address, without the user (`mine`: Reply's
 * own rule, `identitiesIn`, so the two never disagree). Senders first, in the order they first wrote, then the people only
 * written to, in the order they first appear. A person's name is the one they sign with (their From), else the first one
 * someone wrote them with, else their address.
 */
export function threadPeople(messages: readonly MessageDetail[], mine: (email: string) => boolean): ThreadPerson[] {
  const order: string[] = [];
  const found = new Map<string, { email: string; own: string; given: string; lastSent: MessageDetail | null }>();
  const note = (a: Address, from: MessageDetail | null) => {
    const key = fold(a.email);
    if (!key || mine(a.email)) return;
    const name = a.name?.trim() ?? "";
    let p = found.get(key);
    if (!p) {
      found.set(key, (p = { email: a.email, own: "", given: "", lastSent: null }));
      order.push(key);
    }
    if (from) {
      p.lastSent = from;
      if (name) p.own = name;
    } else if (name && !p.given) p.given = name;
  };
  // senders first: every From before any recipient, so the order is who wrote, then who was only written to
  for (const m of messages) if (!m.isSent) note(m.from, m);
  for (const m of messages) for (const a of [...m.to, ...m.cc]) note(a, null);
  const people: ThreadPerson[] = order.map((key) => {
    const p = found.get(key)!;
    return { email: p.email, name: p.own || p.given || p.email, short: "", wrote: p.lastSent !== null, lastSent: p.lastSent };
  });
  const count = (f: (p: ThreadPerson) => string) => {
    const n = new Map<string, number>();
    for (const p of people) n.set(f(p).toLowerCase(), (n.get(f(p).toLowerCase()) ?? 0) + 1);
    return (p: ThreadPerson) => n.get(f(p).toLowerCase()) ?? 0;
  };
  const sameFirst = count((p) => firstName(p.name, p.email));
  const sameName = count((p) => p.name);
  // two Anas: their full names; two Ana Lópezes: their addresses
  for (const p of people) p.short = sameFirst(p) < 2 ? firstName(p.name, p.email) : sameName(p) < 2 ? p.name : p.email;
  return people;
}

export interface ThreadFile {
  /** the message it came with: retrying an uncached file asks for that message's */
  message: MessageDetail;
  attachment: AttachmentInfo;
}

/**
 * Every file of every message, oldest message first. Never merged: a name and a size don't make two files the same (a
 * second revision of report.pdf can weigh the same), and each copy has its own message and cache state.
 */
export function threadFiles(messages: readonly MessageDetail[]): ThreadFile[] {
  return messages.flatMap((message) => message.attachments.map((attachment) => ({ message, attachment })));
}
