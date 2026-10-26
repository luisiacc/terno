/**
 * Plan 22: which site a sender's icon comes from. One registrable domain
 * (eTLD+1, the Public Suffix List's ICANN section) per sender, never the
 * address: `mail.netflix.com` and `info.netflix.com` are both `netflix.com`.
 */
import { isFreemail } from "./freemail";

type Psl = typeof import("tldts");
let psl: Psl | null = null;
let loading: Promise<Psl> | null = null;

/** The suffix list (~130 KB) loads on the first lookup, never before icons are needed. */
export function loadSuffixList(): Promise<void> {
  if (psl) return Promise.resolve();
  loading ??= import("tldts").then((m) => (psl = m));
  return loading.then(() => {});
}

/** A sender's host: lowercased, trailing dot dropped, IDN as punycode; null for what isn't a public hostname. */
export function senderHost(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  let host = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || /[\s/\\?#@:[\]%]/.test(host)) return null;
  try {
    host = new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
  if (!host.includes(".") || /^[\d.]+$/.test(host)) return null;
  return host;
}

/** eTLD+1 of a host, or null when the host is a bare suffix, an IP or not under an ICANN suffix (`.local`, `.test`, `localhost`). Needs loadSuffixList(). */
export function registrableDomain(host: string): string | null {
  if (!psl) throw new Error("registrableDomain before loadSuffixList()");
  const p = psl.parse(host, { allowPrivateDomains: false });
  if (p.isIp || p.isIcann !== true || !p.domain) return null;
  return p.domain;
}

/** What an address can be shown with: its site's icon, or (freemail, no usable domain) only a photo. */
export type IconSubject = { kind: "site"; domain: string } | { kind: "photo-only" };

export function iconSubject(email: string): IconSubject {
  const host = senderHost(email);
  const domain = host ? registrableDomain(host) : null;
  if (!domain || isFreemail(domain)) return { kind: "photo-only" };
  return { kind: "site", domain };
}

/** An address as the photo map keys it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
