import type { Address } from "./types";

const NEEDS_QUOTES = /[",;<>@()[\]:\\]/;

/** Formats one address; display names with specials are quoted so they can't become extra recipients. */
export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const name = NEEDS_QUOTES.test(a.name) ? `"${a.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.email}>`;
}

export function formatAddressList(list: readonly Address[]): string {
  return list.map(formatAddress).join(", ");
}

/**
 * Parses "Ana <ana@x.com>, \"Pérez, Luis\" <l@y.com>; bob@z.com". Separators
 * inside quotes or angle brackets don't split, so a display name containing
 * commas or addresses stays a single recipient.
 */
export function parseAddressList(input: string): Address[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && inQuotes && i + 1 < input.length) {
      current += ch + input[++i];
      continue;
    }
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if ((ch === "," || ch === ";" || ch === "\n") && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(part);
      if (!m) return { name: "", email: part };
      let name = m[1]!.trim();
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
      return { name, email: m[2]!.trim() };
    });
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email);
}
