const timeFmt = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const yearFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Compact list date: time today, "3 oct" this year, "3 oct 2024" before. */
export function listDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === n.getFullYear()) return dayFmt.format(d).replace(".", "");
  return yearFmt.format(d).replace(".", "");
}

export function fullDate(ms: number): string {
  return fullFmt.format(new Date(ms));
}

export function initials(name: string): string {
  const parts = name.replace(/[<>"]/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

const AVATAR = ["rose", "amber", "lime", "emerald", "cyan", "indigo", "violet", "slate"] as const;
export function avatarColor(seed: string): (typeof AVATAR)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR[Math.abs(h) % AVATAR.length]!;
}

export const VIEW_LABEL: Record<string, string> = {
  inbox: "Entrada",
  starred: "Destacados",
  sent: "Enviados",
  archive: "Archivo",
  spam: "Spam",
  trash: "Papelera",
  all: "Todo el correo",
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
