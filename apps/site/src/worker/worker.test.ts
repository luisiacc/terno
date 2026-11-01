import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deploySteps, runSteps } from "../deploy-steps.mjs";
import { csvCell, rowsFromWrangler, toCsv, waitlistQuery } from "../waitlist-csv.mjs";
import { handleDownload, pickDmg } from "./download";
import worker, { type Env } from "./index";
import { MAX_ROWS, handleWaitlist, parseFields, validEmail } from "./waitlist";

/**
 * D1 on a real SQLite (node:sqlite) with the real migration, so the SQL the Worker runs is the SQL tested.
 * `fail` makes every statement throw, as a D1 outage would.
 */
function fakeDb(o: { fail?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../migrations/0001_waitlist.sql", import.meta.url), "utf8"));
  const keys = () => (sqlite.prepare("SELECT email, platform FROM waitlist ORDER BY email, platform").all() as { email: string; platform: string }[]).map((r) => `${r.email}|${r.platform}`);
  const db = {
    sqlite,
    keys,
    prepare(sql: string) {
      let args: SQLInputValue[] = [];
      const stmt = {
        bind: (...a: SQLInputValue[]) => ((args = a), stmt),
        first: async () => {
          if (o.fail) throw new Error("D1 down");
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        run: async () => {
          if (o.fail) throw new Error("D1 down");
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { keys: () => string[]; sqlite: DatabaseSync };
}
/** n rows from other people */
function fill(db: { sqlite: DatabaseSync }, n: number) {
  const insert = db.sqlite.prepare("INSERT INTO waitlist (email, platform, created_at) VALUES (?, 'linux', 0)");
  for (let i = 0; i < n; i++) insert.run(`p${i}@example.com`);
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
    expect(DB.keys()).toEqual(["ana@example.com|linux", "ana@example.com|windows"]);
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
    expect(DB.keys().length).toBe(0);
  });

  it("refuses an unknown content type and a body over 2 KB whatever Content-Length says", async () => {
    const DB = fakeDb();
    expect((await handleWaitlist(post("email=a@b.co", "text/plain"), { DB })).status).toBe(415);
    const big = JSON.stringify({ email: "a@b.co", platform: "linux", pad: "x".repeat(3000) });
    const res = await handleWaitlist(post(big, "application/json", { "content-length": "10" }), { DB });
    expect(res.status).toBe(413);
    expect(DB.keys().length).toBe(0);
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
    expect(DB.keys().length).toBe(0);
  });

  it("says busy when rate limited, full at the cap, error when D1 fails", async () => {
    const body = JSON.stringify({ email: "a@b.co", platform: "linux" });
    expect(await (await handleWaitlist(post(body), { DB: fakeDb(), WAITLIST_LIMIT: limiter(false) })).json()).toEqual({ ok: false, error: "busy" });
    expect(await (await handleWaitlist(post(body), { DB: fakeDb({ fail: true }) })).json()).toEqual({ ok: false, error: "error" });
  });

  it("holds the cap in one statement: at the boundary only one of two sign-ups gets in; a repeat is still thanked when full", async () => {
    const DB = fakeDb();
    fill(DB, 9);
    const [a, b] = await Promise.all(["a@x.co", "b@x.co"].map((email) => handleWaitlist(post(JSON.stringify({ email, platform: "windows" })), { DB }, 10).then((r) => r.json())));
    expect([a, b]).toContainEqual({ ok: true });
    expect([a, b]).toContainEqual({ ok: false, error: "full" });
    expect(DB.keys()).toHaveLength(10);
    const winner = (a as { ok: boolean }).ok ? "a@x.co" : "b@x.co";
    expect(await (await handleWaitlist(post(JSON.stringify({ email: winner, platform: "windows" })), { DB }, 10)).json()).toEqual({ ok: true });
    expect(DB.keys()).toHaveLength(10);
    expect(MAX_ROWS).toBe(50_000);
  });

  it("keeps the first Apple-silicon build's list apart from Intel Macs", async () => {
    const DB = fakeDb();
    for (const platform of ["mac", "mac-intel"]) await handleWaitlist(post(JSON.stringify({ email: "m@x.co", platform })), { DB });
    expect(DB.keys()).toEqual(["m@x.co|mac", "m@x.co|mac-intel"]);
  });

  it("refuses control characters and invalid domains without storing them", async () => {
    const DB = fakeDb();
    for (const email of ["a\u0000@b.co", "a@-bad-.example", "a@b.c0", "a\t@b.co"]) {
      const res = await handleWaitlist(post(`{"email":"${email}","platform":"linux"}`), { DB });
      expect(await res.json(), email).toEqual({ ok: false, error: "invalid" });
    }
    expect(DB.keys()).toEqual([]);
  });

  it("validates emails plainly", () => {
    expect(validEmail("a@b.co")).toBe(true);
    expect(validEmail("first.last+tag@mail.example-site.com")).toBe(true);
    for (const e of ["a@b", "a b@c.co", "@b.co", "a@.co", "a@b..co", `${"a".repeat(65)}@b.co`, "a@b@c.co", "a@b-.co", "a\u007f@b.co"]) expect(validEmail(e), e).toBe(false);
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

describe("download cache", () => {
  /** the Cache API, enough for one key */
  const memoryCache = () => {
    const m = new Map<string, Response>();
    return { match: async (r: Request) => m.get(r.url)?.clone(), put: async (r: Request, res: Response) => void m.set(r.url, res) } as unknown as Cache;
  };

  it("remembers a failed lookup too, so an outage or GitHub's rate limit isn't hit on every click", async () => {
    const req = new Request("https://terno.app/download/mac");
    let calls = 0;
    const failing = async () => (calls++, new Response("rate limited", { status: 403 }));
    const cache = memoryCache();
    for (let i = 0; i < 3; i++) expect((await handleDownload(req, failing, cache)).headers.get("location")).toBe("https://terno.app/download/");
    expect(calls).toBe(1);
    let offline = 0;
    const cache2 = memoryCache();
    for (let i = 0; i < 3; i++) await handleDownload(req, async () => { offline++; throw new Error("offline"); }, cache2);
    expect(offline).toBe(1);
  });

  it("serves a found DMG from the cache", async () => {
    const req = new Request("https://terno.app/download/mac");
    let calls = 0;
    const cache = memoryCache();
    for (let i = 0; i < 2; i++) {
      const res = await handleDownload(req, async () => (calls++, Response.json([release({ name: "Terno-1.0.0-arm64.dmg" })])), cache);
      expect(res.headers.get("location")).toMatch(/Terno-1\.0\.0-arm64\.dmg$/);
    }
    expect(calls).toBe(1);
  });
});

describe("deploy", () => {
  for (const preview of [false, true])
    it(`${preview ? "preview" : "production"}: the database is created and migrated before the Worker goes live; a failing migration stops the deploy`, async () => {
      const steps = deploySteps({ preview });
      const names = steps.map((s) => s.name);
      expect(names.indexOf("database")).toBeLessThan(names.indexOf("migrations"));
      expect(names.indexOf("migrations")).toBeLessThan(names.indexOf("deploy"));
      expect(names.at(-1)).toBe("deploy");
      for (const s of steps.filter((s) => s.args?.includes("wrangler") && !s.args.includes("whoami"))) expect(s.args).toEqual(expect.arrayContaining(["--env", preview ? "preview" : ""]));
      expect(steps.find((s) => s.name === "database")!.ensureDatabase).toBe(preview ? "terno-site-waitlist-preview" : "terno-site-waitlist");
      const ran: string[] = [];
      const result = await runSteps(steps, { exec: async (s: { name: string }) => (ran.push(s.name), { ok: s.name !== "migrations", stdout: "" }), ensureDatabase: async () => (ran.push("database"), true) });
      expect(result).toMatchObject({ ok: false, failed: "migrations" });
      expect(ran).not.toContain("deploy");
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

describe("waitlist CSV", () => {
  it("queries one known platform or all, and refuses anything else", () => {
    expect(waitlistQuery()).toBe("SELECT email, platform, created_at FROM waitlist ORDER BY platform, created_at");
    expect(waitlistQuery("linux")).toContain("WHERE platform = 'linux'");
    expect(() => waitlistQuery("linux' OR 1=1 --")).toThrow(/unknown platform/);
  });

  it("writes a header, ISO dates, quotes what needs it and defuses spreadsheet formulas", () => {
    const csv = toCsv([
      { email: "ana@example.com", platform: "linux", created_at: Date.UTC(2026, 10, 1, 9, 30) },
      { email: '"odd,one"@example.com', platform: "windows", created_at: 0 },
      { email: "=HYPERLINK(1)@x.co", platform: "mac", created_at: 0 },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "email,platform,joined",
      "ana@example.com,linux,2026-11-01T09:30:00.000Z",
      '"""odd,one""@example.com",windows,1970-01-01T00:00:00.000Z',
      "'=HYPERLINK(1)@x.co,mac,1970-01-01T00:00:00.000Z",
      "",
    ]);
    expect(csvCell("+1")).toBe("'+1");
    expect(toCsv([])).toBe("email,platform,joined\r\n");
  });

  it("reads wrangler's JSON, and says so when the query failed", () => {
    const out = 'some log line\n[{"results":[{"email":"a@b.co","platform":"linux","created_at":1}],"success":true,"meta":{}}]';
    expect(rowsFromWrangler(out)).toEqual([{ email: "a@b.co", platform: "linux", created_at: 1 }]);
    expect(() => rowsFromWrangler('[{"success":false}]')).toThrow(/query failed/);
    expect(() => rowsFromWrangler("✘ no such table")).toThrow(/no results/);
  });
});
