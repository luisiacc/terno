import { describe, expect, it } from "vitest";
import { handleDownload, pickDmg } from "./download";
import worker, { type Env } from "./index";
import { MAX_ROWS, handleWaitlist, parseFields, validEmail } from "./waitlist";

/** D1 enough for the waitlist: a count and an insert that ignores repeats (the table's primary key). */
function fakeDb(o: { rows?: number; fail?: boolean } = {}) {
  const rows = new Map<string, number>();
  const db = {
    rows,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        first: async () => {
          if (o.fail) throw new Error("D1 down");
          return { n: o.rows ?? rows.size };
        },
        run: async () => {
          if (o.fail) throw new Error("D1 down");
          if (sql.startsWith("INSERT")) {
            const key = `${args[0]}|${args[1]}`;
            if (!rows.has(key)) rows.set(key, args[2] as number);
          }
          return {};
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { rows: Map<string, number> };
}
const limiter = (ok: boolean) => ({ limit: async () => ({ success: ok }) }) as unknown as RateLimit;
const post = (body: string, type = "application/json", headers: Record<string, string> = {}) =>
  new Request("https://terno.app/api/waitlist", { method: "POST", body, headers: { "content-type": type, ...headers } });

describe("waitlist", () => {
  it("stores a valid email once per platform, lowercased; a repeat is a quiet success", async () => {
    const DB = fakeDb();
    for (const email of ["Ana@Example.com", "ana@example.com"]) {
      const res = await handleWaitlist(post(JSON.stringify({ email, platform: "linux" })), { DB });
      expect(await res.json()).toEqual({ ok: true });
    }
    await handleWaitlist(post(JSON.stringify({ email: "ana@example.com", platform: "windows" })), { DB });
    expect([...DB.rows.keys()]).toEqual(["ana@example.com|linux", "ana@example.com|windows"]);
  });

  it("refuses bad emails, unknown platforms, malformed JSON, non-strings and repeated form fields", async () => {
    const DB = fakeDb();
    const cases = [
      post(JSON.stringify({ email: "nope", platform: "linux" })),
      post(JSON.stringify({ email: "a@b.co", platform: "beos" })),
      post("{not json"),
      post(JSON.stringify(["a@b.co"])),
      post(JSON.stringify({ email: ["a@b.co"], platform: "linux" })),
    ];
    for (const req of cases) {
      const res = await handleWaitlist(req, { DB });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    }
    const form = await handleWaitlist(post("email=a%40b.co&email=c%40d.co&platform=linux", "application/x-www-form-urlencoded"), { DB });
    expect(form.headers.get("location")).toBe("/waitlist/#invalid");
    expect(DB.rows.size).toBe(0);
  });

  it("refuses an unknown content type and a body over 2 KB whatever Content-Length says", async () => {
    const DB = fakeDb();
    expect((await handleWaitlist(post("email=a@b.co", "text/plain"), { DB })).status).toBe(415);
    const big = JSON.stringify({ email: "a@b.co", platform: "linux", pad: "x".repeat(3000) });
    const res = await handleWaitlist(post(big, "application/json", { "content-length": "10" }), { DB });
    expect(res.status).toBe(413);
    expect(DB.rows.size).toBe(0);
  });

  it("without JS answers 303 to the waitlist page's outcome, in the form's language", async () => {
    const DB = fakeDb();
    const ok = await handleWaitlist(post("email=a%40b.co&platform=windows&lang=es", "application/x-www-form-urlencoded"), { DB });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/es/waitlist/#thanks");
    const bad = await handleWaitlist(post("email=x&platform=windows&lang=en", "application/x-www-form-urlencoded"), { DB });
    expect(bad.headers.get("location")).toBe("/waitlist/#invalid");
  });

  it("thanks a bot that fills the honeypot and stores nothing", async () => {
    const DB = fakeDb();
    const res = await handleWaitlist(post(JSON.stringify({ email: "bot@spam.co", platform: "linux", website: "http://spam" })), { DB });
    expect(await res.json()).toEqual({ ok: true });
    expect(DB.rows.size).toBe(0);
  });

  it("says busy when rate limited, full at the cap, error when D1 fails", async () => {
    const body = JSON.stringify({ email: "a@b.co", platform: "linux" });
    expect(await (await handleWaitlist(post(body), { DB: fakeDb(), WAITLIST_LIMIT: limiter(false) })).json()).toEqual({ ok: false, error: "busy" });
    expect(await (await handleWaitlist(post(body), { DB: fakeDb({ rows: MAX_ROWS }) })).json()).toEqual({ ok: false, error: "full" });
    expect(await (await handleWaitlist(post(body), { DB: fakeDb({ fail: true }) })).json()).toEqual({ ok: false, error: "error" });
  });

  it("validates emails plainly", () => {
    expect(validEmail("a@b.co")).toBe(true);
    for (const e of ["a@b", "a b@c.co", "@b.co", "a@.co", "a@b..co", `${"a".repeat(65)}@b.co`]) expect(validEmail(e)).toBe(false);
    expect(parseFields("", "application/json")).toBeNull();
  });
});

const release = (o: { draft?: boolean; prerelease?: boolean; name: string; url?: string }) => ({
  draft: o.draft ?? false,
  prerelease: o.prerelease ?? false,
  assets: [{ name: o.name, browser_download_url: o.url ?? `https://github.com/luisiacc/terno/releases/download/v1/${o.name}` }],
});

describe("download", () => {
  it("picks the newest stable release's arm64 DMG, skipping drafts, nightlies and other assets", () => {
    expect(pickDmg([release({ draft: true, name: "Terno-2.0.0-arm64.dmg" }), release({ prerelease: true, name: "Terno-1.9.0-nightly.3-arm64.dmg" }), release({ name: "Terno-1.8.0-arm64-mac.zip" }), release({ name: "Terno-1.7.0-arm64.dmg" })])).toBe(
      "https://github.com/luisiacc/terno/releases/download/v1/Terno-1.7.0-arm64.dmg",
    );
    expect(pickDmg([release({ name: "Terno-1.7.0-arm64.dmg", url: "https://evil.example/x.dmg" })])).toBeNull();
    expect(pickDmg([])).toBeNull();
  });

  it("falls back to /download/ with no release, a GitHub error or no network", async () => {
    const req = new Request("https://terno.app/download/mac");
    const none = await handleDownload(req, async () => Response.json([]), null);
    expect(none.headers.get("location")).toBe("https://terno.app/download/");
    expect((await handleDownload(req, async () => new Response("rate limited", { status: 403 }), null)).headers.get("location")).toBe("https://terno.app/download/");
    expect((await handleDownload(req, async () => { throw new Error("offline"); }, null)).headers.get("location")).toBe("https://terno.app/download/");
    const found = await handleDownload(req, async () => Response.json([release({ name: "Terno-1.0.0-arm64.dmg" })]), null);
    expect(found.status).toBe(302);
    expect(found.headers.get("location")).toMatch(/Terno-1\.0\.0-arm64\.dmg$/);
  });
});

describe("worker", () => {
  const env = (): Env => ({ DB: fakeDb(), ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher });

  it("sends www to the apex with the path and query", async () => {
    const res = await worker.fetch(new Request("https://www.terno.app/privacy/?ref=x"), env());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://terno.app/privacy/?ref=x");
  });

  it("secures every response; only terno.app is indexable", async () => {
    const prod = await worker.fetch(new Request("https://terno.app/"), env());
    expect(prod.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(prod.headers.get("strict-transport-security")).toContain("max-age=");
    expect(prod.headers.get("x-content-type-options")).toBe("nosniff");
    expect(prod.headers.get("permissions-policy")).toContain("camera=()");
    expect(prod.headers.get("x-robots-tag")).toBeNull();
    const preview = await worker.fetch(new Request("https://terno-site-preview.example.workers.dev/"), env());
    expect(preview.headers.get("x-robots-tag")).toBe("noindex");
    const api = await worker.fetch(post(JSON.stringify({ email: "a@b.co", platform: "linux" })), env());
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(api.headers.get("content-security-policy")).toBeTruthy();
    expect((await worker.fetch(new Request("https://terno.app/api/other"), env())).status).toBe(404);
  });

  it("caches hashed assets for a year", async () => {
    const res = await worker.fetch(new Request("https://terno.app/assets/index-abc.css"), env());
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
