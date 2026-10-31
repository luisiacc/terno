/**
 * Every response's headers (plan 96, Codex 2): assets and the Worker's own alike, so nothing goes out without
 * them. The site runs one same-origin script and no inline script; JSON-LD is data, which CSP doesn't execute.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const PERMISSIONS = ["camera", "microphone", "geolocation", "payment", "usb", "interest-cohort", "browsing-topics", "clipboard-read", "display-capture"].map((p) => `${p}=()`).join(", ");

/** Only the production host is indexed: a preview or workers.dev URL never competes with terno.app. */
export const PRODUCTION_HOST = "terno.app";

export function secure(res: Response, url: URL): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", PERMISSIONS);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (url.hostname !== PRODUCTION_HOST) h.set("X-Robots-Tag", "noindex");
  const path = url.pathname;
  if (path.startsWith("/api/") || path.startsWith("/download/mac")) h.set("Cache-Control", "no-store");
  else if (path.startsWith("/assets/")) h.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (path.startsWith("/shots/") || path === "/og.jpg") h.set("Cache-Control", "public, max-age=86400");
  else if (res.ok) h.set("Cache-Control", "public, max-age=0, must-revalidate");
  return out;
}
