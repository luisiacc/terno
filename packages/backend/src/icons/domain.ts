/**
 * Plan 22: which site a sender's icon comes from. One registrable domain
 * (eTLD+1, the Public Suffix List's ICANN section) per sender, never the
 * address: `mail.netflix.com` and `info.netflix.com` are both `netflix.com`.
 */
import { parse } from "tldts";
import { isFreemail } from "./freemail";

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

/** eTLD+1 of a host, or null when the host is a bare suffix, an IP or not under an ICANN suffix (`.local`, `.test`, `localhost`). */
export function registrableDomain(host: string): string | null {
  const p = parse(host, { allowPrivateDomains: false });
  if (p.isIp || p.isIcann !== true || !p.domain) return null;
  return p.domain;
}

/** The registrable domain whose icon an address is shown with; null for freemail (a person, shown by initials) and addresses with no usable domain. */
export function iconDomain(email: string): string | null {
  const host = senderHost(email);
  const domain = host ? registrableDomain(host) : null;
  return domain && !isFreemail(domain) ? domain : null;
}
