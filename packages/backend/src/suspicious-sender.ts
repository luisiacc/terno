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
]);

/** The registrable domain, or, for a name the list doesn't hold (`.test`, `.local`), its last two labels. */
function siteOf(email: string): string | null {
  const host = senderHost(email);
  if (!host) return null;
  return registrableDomain(host) ?? host.split(".").slice(-2).join(".");
}

export function suspiciousSender(email: string): boolean {
  const site = siteOf(email);
  // the site's own name, its suffix left out ("tririver-fcu-alerts" of tririver-fcu-alerts.com)
  const name = site?.split(".")[0] ?? "";
  if (!name.includes("-")) return false;
  return name.split("-").some((w) => WORDS.has(w));
}
