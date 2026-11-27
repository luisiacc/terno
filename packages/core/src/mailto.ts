import { isValidEmail } from "./address";

/**
 * A mailto URI's one address, subject and body (RFC 6068), empty where it gives none, or null when it isn't one address.
 * Only these three: the cc, bcc and other headers a URI may carry are never used (plans 96, 284).
 */
export function mailtoLink(uri: string): { to: string; subject: string; body: string } | null {
  // a fragment is no part of a mailto (an encoded %23 is a "#" in what it says)
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(uri.trim());
  if (!m) return null;
  let to: string;
  const params = new Map<string, string>();
  try {
    to = decodeURIComponent(m[1]!).trim();
    for (const pair of (m[2] ?? "").split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
      // a "+" is a plus (tokens use it); a space comes as %20
      if (!params.has(key)) params.set(key, decodeURIComponent(pair.slice(eq + 1)));
    }
  } catch {
    return null;
  }
  // one recipient, no extra headers smuggled in the address part, nobody else in a "to" field
  if (!to || /[,;\s]/.test(to) || !isValidEmail(to) || params.has("to")) return null;
  const subject = (params.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  return { to, subject, body: (params.get("body") ?? "").slice(0, 10_000) };
}
