import { addressKey } from "@terno/core";
import { registrableDomain, senderHost } from "./icons/domain";

/**
 * Plan 204 (after the fourth panel round): a sender whose own site is named like a bank's security desk, two phishing
 * mails the panel's Today showed as alerts ("security@tririver-fcu-alerts.com", while the real bank writes from
 * tririverfcu.org; "seguridad@bbva-mx-alertas.com.verifica-acceso.info"). What decides is the registrable domain (the
 * Public Suffix List's, as plan 22's icons read it: `accounts.google.com` is google.com, `bbva.com.mx` keeps its
 * `.com.mx`): words joined by a hyphen, one of them a security or account word, in English or Spanish. A bank's real
 * domain is its name ("tririverfcu.org", "bbva.mx"); one made to look like a security desk is the impostor's. Conservative
 * by design: no hyphen, no word, nothing said. Local, and no list to fetch.
 */
const WORDS: ReadonlySet<string> = new Set([
  "alert", "alerts", "secure", "security", "verify", "verification", "login", "signin", "account", "accounts", "support", "update", "updates",
  "seguridad", "verifica", "verificar", "verificacion", "acceso", "cuenta", "cuentas", "alerta", "alertas", "soporte",
  // plan 210 (iteration 4's code review): a helpdesk's and a credential's words too
  "helpdesk", "validate", "validation", "appeal", "appeals", "recovery", "password", "validar", "validacion", "recuperacion", "contrasena",
]);

/** The registrable domain, or, for a name the list doesn't hold (`.test`, `.local`), its last two labels. */
function siteOf(email: string): string | null {
  const host = senderHost(email);
  if (!host) return null;
  return registrableDomain(host) ?? host.split(".").slice(-2).join(".");
}

/** Which of these senders (`addressKey`s) the user has written to: the store's `dated.written`, one indexed lookup each. */
export type WrittenTo = (senderKeys: readonly string[]) => Promise<ReadonlySet<string>>;

/**
 * The guard as everything applies it (Codex's second pass): the senders among these named like a security desk whom the
 * user has never written to. Someone you correspond with (jane@acme-support.com, your consultant) keeps her asks and
 * invoices, whatever her domain's words. Asks the store only when a sender looks suspicious, so most reads ask nothing.
 */
export async function untrustedSenders(emails: Iterable<string>, writtenTo: WrittenTo, own: readonly string[] = []): Promise<Set<string>> {
  const suspicious = [...new Set([...emails].map(addressKey))].filter((key) => suspiciousSender(key) || impersonates(key, own));
  if (!suspicious.length) return new Set();
  const trusted = await writtenTo(suspicious);
  return new Set(suspicious.filter((key) => !trusted.has(key)));
}

/** Rows from a sender `untrustedSenders` leaves out, gone (an item stored before the guard, Codex's second pass). */
export async function withoutUntrusted<T extends { senderKey: string }>(rows: readonly T[], writtenTo: WrittenTo): Promise<readonly T[]> {
  const out = await untrustedSenders(rows.map((r) => r.senderKey), writtenTo);
  return out.size ? rows.filter((r) => !out.has(r.senderKey)) : rows;
}

export function suspiciousSender(email: string): boolean {
  const site = siteOf(email);
  // the site's own name, its suffix left out ("tririver-fcu-alerts" of tririver-fcu-alerts.com)
  const name = site?.split(".")[0] ?? "";
  if (!name.includes("-")) return false;
  return name.split("-").some((w) => WORDS.has(w));
}

/**
 * Plan 210 (iteration 4's code review): a site named like the reader's own organization's with a word joined by a hyphen
 * isn't theirs: the panel's "it-helpdesk@lumora-io.co" to priya@lumora.io, while Lumora writes from lumora.io. `own` is the
 * reader's accounts' addresses; their site's name, four letters or more, is one of the sender's hyphenated words, and the
 * sites differ. Like `suspiciousSender`, the caller trusts whoever the user has written to.
 */
export function impersonates(email: string, own: readonly string[]): boolean {
  const site = siteOf(email);
  const name = site?.split(".")[0] ?? "";
  if (!site || !name.includes("-")) return false;
  const words = name.split("-");
  return own.some((mine) => {
    const theirs = siteOf(mine);
    const label = theirs?.split(".")[0] ?? "";
    return !!theirs && theirs !== site && label.length >= 4 && words.includes(label);
  });
}
