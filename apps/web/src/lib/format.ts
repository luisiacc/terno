import { CATEGORY_COLORS, dateStyle, fullDateFormat, type CategoryColor, type DateStyle } from "@terno/core";
import { formatNumber, getLocale, t, type LocaleId } from "@terno/i18n";

interface Formats {
  style: DateStyle;
  time: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  year: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
}
const cache = new Map<LocaleId, Formats>();

function formats(): Formats {
  const id = getLocale();
  let f = cache.get(id);
  if (!f) {
    const style = dateStyle(id);
    f = {
      style,
      time: new Intl.DateTimeFormat(style.tag, style.time),
      day: new Intl.DateTimeFormat(style.tag, { day: "numeric", month: "short" }),
      year: new Intl.DateTimeFormat(style.tag, { day: "numeric", month: "short", year: "numeric" }),
      full: fullDateFormat(id),
    };
    cache.set(id, f);
  }
  return f;
}

/** Compact list date: the time today, "Yesterday" (English), "Oct 22" this year, "Oct 22, 2024" before. */
export function listDate(ms: number, now = Date.now()): string {
  const f = formats();
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return f.time.format(d);
  if (f.style.yesterday) {
    // the calendar day before (setDate keeps local time across DST)
    const y = new Date(n);
    y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return t("date.yesterday");
  }
  const out = (d.getFullYear() === n.getFullYear() ? f.day : f.year).format(d);
  return f.style.stripPeriod ? out.replace(".", "") : out;
}

/** A message's own date: the list's, with the time added on an earlier day, so a conversation's messages can be told apart and put in order. */
export function messageDate(ms: number, now = Date.now()): string {
  const day = listDate(ms, now);
  const time = formats().time.format(new Date(ms));
  return day === time ? day : `${day}, ${time}`;
}

/** What messageDate adds to listDate (", 3:41 PM"), so a tight row can give it up first. */
export function messageTime(ms: number, now = Date.now()): string {
  return messageDate(ms, now).slice(listDate(ms, now).length);
}

export function fullDate(ms: number): string {
  return formats().full.format(new Date(ms));
}

export function initials(name: string): string {
  const parts = name.replace(/[<>"]/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

/** an avatar's tint: the category colors (plan 194: none of them blue, as unread is in most palettes) */
const AVATAR = CATEGORY_COLORS;
export function avatarColor(seed: string): CategoryColor {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR[Math.abs(h) % AVATAR.length]!;
}

const VIEW_KEYS = { inbox: "view.inbox", starred: "view.starred", sent: "view.sent", archive: "view.archive", spam: "view.spam", trash: "view.trash", all: "view.all" } as const;

/** A mailbox's name ("Inbox", "Entrada"); an unknown view shows its id. */
export function viewLabel(view: string): string {
  return Object.hasOwn(VIEW_KEYS, view) ? t(VIEW_KEYS[view as keyof typeof VIEW_KEYS]) : view;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 * 1024) return `${formatNumber(Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${formatNumber(n / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  return `${formatNumber(n / 1024 / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
}
