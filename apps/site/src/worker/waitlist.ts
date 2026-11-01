/**
 * POST /api/waitlist (plan 96): `{ email, platform, lang, website }` as JSON (the page's script) or a form post
 * (no JS). Bounded: a 2 KB body read as a stream, an approximate per-IP rate limit, at most MAX_ROWS rows.
 * Nothing about the request is logged.
 */
export const MAX_BODY = 2048;
export const MAX_ROWS = 50_000;
const PLATFORMS = new Set(["windows", "linux", "mac", "mac-intel"]);
export type Outcome = "thanks" | "invalid" | "busy" | "full" | "error";

export interface WaitlistEnv {
  DB: D1Database;
  WAITLIST_LIMIT?: RateLimit;
}

/** Reads at most `max` bytes; null when the body is larger, whatever Content-Length says. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A deliberately plain check: no spaces or control characters, a dotted domain of valid labels, the lengths SMTP allows. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export function validEmail(email: string): boolean {
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (email.length > 254 || /[\s\u0000-\u001f\u007f]/.test(email)) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split(".");
  if (at < 1 || local.length > 64 || local.includes("@") || labels.length < 2) return false;
  return labels.every((l) => LABEL.test(l)) && /^[a-z]{2,63}$/i.test(labels.at(-1)!);
}

type Fields = { email: string; platform: string; lang: string; website: string };

/** The fields, or null for a body that isn't one well-formed submission (bad JSON, repeated fields, wrong types). */
export function parseFields(body: string, type: string): Fields | null {
  let get: (k: keyof Fields) => unknown;
  if (type.startsWith("application/json")) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    get = (k) => (data as Record<string, unknown>)[k];
  } else if (type.startsWith("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    for (const k of ["email", "platform", "lang", "website"]) if (params.getAll(k).length > 1) return null;
    get = (k) => params.get(k) ?? undefined;
  } else return null;
  const out = {} as Fields;
  for (const k of ["email", "platform", "lang", "website"] as const) {
    const v = get(k) ?? "";
    if (typeof v !== "string") return null;
    out[k] = v.trim();
  }
  return out;
}

export async function handleWaitlist(req: Request, env: WaitlistEnv, maxRows = MAX_ROWS): Promise<Response> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const json = type.startsWith("application/json");
  let lang = "en";
  const answer = (outcome: Outcome, status: number) => {
    if (json) return Response.json(outcome === "thanks" ? { ok: true } : { ok: false, error: outcome }, { status });
    // no JS: back to a page that shows the outcome by its fragment (:target)
    return new Response(null, { status: 303, headers: { Location: `${lang === "es" ? "/es" : ""}/waitlist/#${outcome}` } });
  };
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const body = await readCapped(req, MAX_BODY);
  if (body === null) return answer("invalid", 413);
  const fields = parseFields(body, type);
  if (!fields) return json || type.startsWith("application/x-www-form-urlencoded") ? answer("invalid", 400) : new Response("Unsupported Media Type", { status: 415 });
  lang = fields.lang === "es" ? "es" : "en";
  // the honeypot: thanked, never stored
  if (fields.website) return answer("thanks", 200);
  const email = fields.email.toLowerCase();
  if (!validEmail(email) || !PLATFORMS.has(fields.platform)) return answer("invalid", 400);
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.WAITLIST_LIMIT) {
    const { success } = await env.WAITLIST_LIMIT.limit({ key: ip });
    if (!success) return answer("busy", 429);
  }
  try {
    // one statement, so the cap holds under concurrent sign-ups (D1 runs each statement atomically)
    const insert = await env.DB.prepare(
      "INSERT INTO waitlist (email, platform, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM waitlist) < ?4 ON CONFLICT (email, platform) DO NOTHING",
    )
      .bind(email, fields.platform, Date.now(), maxRows)
      .run();
    if (!insert.meta.changes) {
      // a repeat is a quiet success, even once the list is full: the person is on it either way
      const there = await env.DB.prepare("SELECT 1 AS one FROM waitlist WHERE email = ?1 AND platform = ?2").bind(email, fields.platform).first();
      if (!there) return answer("full", 503);
    }
  } catch {
    return answer("error", 500);
  }
  return answer("thanks", 200);
}
