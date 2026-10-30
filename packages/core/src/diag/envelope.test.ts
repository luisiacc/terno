import { describe, expect, it } from "vitest";
import { createReporter, parseDsn, rateLimitUntil, serializeEnvelope, type ReportFetch } from "./envelope";
import { buildReport } from "./report";
import type { ErrorRecord } from "./types";

const DSN = "http://publickey@127.0.0.1:9/42";

function record(id: string): ErrorRecord {
  return {
    id,
    ts: 1_700_000_000_000,
    kind: "error",
    proc: "main",
    code: "export.failed",
    fields: { errno: "ENOSPC" },
    fatal: false,
    error: { name: "Error", code: "ENOSPC", frames: [{ fn: "w", file: "dist/main.cjs", line: 3, col: 7 }] },
    crumbs: [{ ts: 1_699_999_000_000, cat: "ui", code: "ui.dialog", level: "info", fields: { dialog: "settings" } }],
    context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "darwin" },
  };
}

const headersOf = (h: Record<string, string> = {}) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

/** A fake network: decodes every envelope it receives and answers as told. */
function sink(respond: () => { status: number; headers?: Record<string, string> } | Promise<{ status: number; headers?: Record<string, string> }> = () => ({ status: 200 })) {
  const requests: { url: string; headers: Record<string, string>; header: Record<string, unknown>; items: { header: Record<string, unknown>; payload: unknown }[]; raw: string }[] = [];
  const fetch: ReportFetch = async (url, init) => {
    const lines = init.body.split("\n").filter(Boolean);
    const items = [];
    for (let i = 1; i < lines.length; i += 2) items.push({ header: JSON.parse(lines[i]!), payload: JSON.parse(lines[i + 1]!) });
    requests.push({ url, headers: init.headers, header: JSON.parse(lines[0]!), items, raw: init.body });
    const r = await respond();
    return { status: r.status, headers: headersOf(r.headers) };
  };
  return { requests, fetch };
}

const options = { installId: "install-1" };
const reporterFor = (s: ReturnType<typeof sink>, more: Partial<Parameters<typeof createReporter>[0]> = {}) => createReporter({ dsn: DSN, client: "terno/0.1.0", fetch: s.fetch, allow: () => true, ...more });

describe("parseDsn", () => {
  it("finds the envelope endpoint and the public key", () => {
    expect(parseDsn("https://94ef@o1.ingest.us.sentry.io/4512346705166336")).toEqual({
      url: "https://o1.ingest.us.sentry.io/api/4512346705166336/envelope/",
      key: "94ef",
      dsn: "https://94ef@o1.ingest.us.sentry.io/4512346705166336",
    });
    expect(parseDsn("http://k@127.0.0.1:9000/sub/path/7")?.url).toBe("http://127.0.0.1:9000/sub/path/api/7/envelope/");
  });

  it("refuses what isn't a DSN", () => {
    for (const bad of ["", "nope", "https://o1.ingest.sentry.io/1", "https://k@host/", "https://k@host/abc", "ftp://k@host/1", "https://k:secret@host/1"]) expect(parseDsn(bad)).toBeNull();
  });
});

describe("reporter", () => {
  it("sends exactly the built event, nothing else, as one event envelope", async () => {
    const s = sink();
    const event = buildReport(record("a".repeat(32)), options);
    await expect(reporterFor(s).send(event)).resolves.toEqual({ sent: true, status: 200 });
    expect(s.requests).toHaveLength(1);
    const [req] = s.requests;
    expect(req!.url).toBe("http://127.0.0.1:9/api/42/envelope/");
    expect(req!.headers["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(req!.headers["X-Sentry-Auth"]).toBe("Sentry sentry_version=7, sentry_key=publickey, sentry_client=terno/0.1.0");
    expect(req!.header).toMatchObject({ event_id: event.event_id, dsn: DSN });
    expect(req!.items).toHaveLength(1);
    expect(req!.items[0]!.header).toEqual({ type: "event", length: new TextEncoder().encode(JSON.stringify(event)).length });
    // what "What gets sent" shows is what went out
    expect(req!.items[0]!.payload).toEqual(event);
  });

  it("a page sends a simple request: the key in the URL, a text body, no preflight", async () => {
    const s = sink();
    await reporterFor(s, { auth: "query" }).send(buildReport(record("a".repeat(32)), options));
    expect(s.requests[0]!.url).toBe("http://127.0.0.1:9/api/42/envelope/?sentry_version=7&sentry_key=publickey&sentry_client=terno%2F0.1.0");
    expect(s.requests[0]!.headers).toEqual({ "Content-Type": "text/plain;charset=UTF-8" });
  });

  it("an item's length counts bytes, not characters", () => {
    const event = { ...buildReport(record("a".repeat(32)), options), tags: { locale: "español·ñ" } };
    const lines = serializeEnvelope(event, parseDsn(DSN)!).split("\n");
    expect(JSON.parse(lines[1]!).length).toBe(new TextEncoder().encode(lines[2]!).length);
    expect(JSON.parse(lines[1]!).length).toBeGreaterThan(lines[2]!.length);
  });

  it("asks the policy per report: a refusal never reaches the network", async () => {
    const s = sink();
    let allowed = false;
    const results: string[] = [];
    const reporter = reporterFor(s, { allow: () => allowed, onResult: (_id, r) => results.push(r.sent ? "sent" : r.reason) });
    await expect(reporter.send(buildReport(record("b".repeat(32)), options))).resolves.toEqual({ sent: false, reason: "policy" });
    allowed = true;
    await reporter.send(buildReport(record("c".repeat(32)), options));
    expect(results).toEqual(["policy", "sent"]);
    expect(s.requests.map((e) => e.header.event_id)).toEqual(["c".repeat(32)]);
  });

  it("a build with a broken DSN sends nothing", async () => {
    const s = sink();
    const reporter = createReporter({ dsn: "not a dsn", client: "terno/0", fetch: s.fetch, allow: () => true });
    expect(await reporter.send(buildReport(record("b".repeat(32)), options))).toEqual({ sent: false, reason: "policy" });
    expect(s.requests).toHaveLength(0);
  });

  it("the same report sent twice at once goes out once (review: Always plus an explicit send)", async () => {
    let release!: () => void;
    const s = sink(() => new Promise((r) => (release = () => r({ status: 200 }))));
    const reporter = reporterFor(s);
    const event = buildReport(record("d".repeat(32)), options);
    const a = reporter.send(event);
    const b = reporter.send(event);
    await Promise.resolve();
    release();
    expect(await a).toEqual({ sent: true, status: 200 });
    expect(await b).toEqual({ sent: true, status: 200 });
    expect(s.requests).toHaveLength(1);
  });

  it("a server error and a network failure are errors; nothing is retried", async () => {
    const failing = sink(() => ({ status: 500 }));
    expect(await reporterFor(failing).send(buildReport(record("e".repeat(32)), options))).toEqual({ sent: false, reason: "error" });
    const throwing: ReportFetch = async () => {
      throw new Error("offline");
    };
    expect(await createReporter({ dsn: DSN, client: "terno/0", fetch: throwing, allow: () => true }).send(buildReport(record("f".repeat(32)), options))).toEqual({ sent: false, reason: "error" });
    expect(failing.requests).toHaveLength(1);
  });

  it("closing aborts what is on the wire", async () => {
    let signal!: AbortSignal;
    const hanging: ReportFetch = (_url, init) =>
      new Promise((_, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const reporter = createReporter({ dsn: DSN, client: "terno/0", fetch: hanging, allow: () => true });
    const p = reporter.send(buildReport(record("1".repeat(32)), options));
    await Promise.resolve();
    reporter.close();
    expect(signal.aborted).toBe(true);
    expect(await p).toEqual({ sent: false, reason: "error" });
    expect(await reporter.send(buildReport(record("2".repeat(32)), options))).toEqual({ sent: false, reason: "policy" });
  });
});

describe("rate limits", () => {
  it("a 429 refuses the next reports without a request until Retry-After passes", async () => {
    let now = 1_000_000;
    const s = sink(() => ({ status: 429, headers: { "retry-after": "60" } }));
    const reporter = reporterFor(s, { now: () => now });
    expect(await reporter.send(buildReport(record("1".repeat(32)), options))).toEqual({ sent: false, reason: "rate" });
    expect(await reporter.send(buildReport(record("2".repeat(32)), options))).toEqual({ sent: false, reason: "rate" });
    expect(s.requests).toHaveLength(1);
    now += 60_001;
    await reporter.send(buildReport(record("3".repeat(32)), options));
    expect(s.requests).toHaveLength(2);
  });

  it("reads Sentry's headers the way its SDK does", () => {
    const now = 1_000_000;
    // X-Sentry-Rate-Limits wins over Retry-After, and applies on any status
    expect(rateLimitUntil(200, headersOf({ "x-sentry-rate-limits": "30:error:organization", "retry-after": "999" }), now)).toBe(now + 30_000);
    // no categories: all of them
    expect(rateLimitUntil(429, headersOf({ "x-sentry-rate-limits": "10::organization" }), now)).toBe(now + 10_000);
    expect(rateLimitUntil(200, headersOf({ "x-sentry-rate-limits": "10:default;transaction:key" }), now)).toBe(now + 10_000);
    // a limit on something we never send isn't ours
    expect(rateLimitUntil(200, headersOf({ "x-sentry-rate-limits": "10:transaction;session:key" }), now)).toBeNull();
    // the longest of several
    expect(rateLimitUntil(429, headersOf({ "x-sentry-rate-limits": "5:error:key, 50::organization" }), now)).toBe(now + 50_000);
    // an HTTP date, a missing header, and an ordinary response
    expect(rateLimitUntil(429, headersOf({ "retry-after": new Date(now + 120_000).toUTCString() }), now)).toBe(Math.floor((now + 120_000) / 1000) * 1000);
    expect(rateLimitUntil(429, headersOf(), now)).toBe(now + 60_000);
    expect(rateLimitUntil(200, headersOf({ "retry-after": "30" }), now)).toBeNull();
  });

  it("a rate limit on a 200 still holds the next one back", async () => {
    let now = 5_000;
    const s = sink(() => ({ status: 200, headers: { "x-sentry-rate-limits": "20:error:key" } }));
    const reporter = reporterFor(s, { now: () => now });
    expect(await reporter.send(buildReport(record("1".repeat(32)), options))).toEqual({ sent: true, status: 200 });
    expect(await reporter.send(buildReport(record("2".repeat(32)), options))).toEqual({ sent: false, reason: "rate" });
    now += 20_001;
    expect(await reporter.send(buildReport(record("3".repeat(32)), options))).toEqual({ sent: true, status: 200 });
  });
});

describe("report releases", () => {
  it("a crash recorded by the previous build is sent under that build's release (review finding 9)", async () => {
    const s = sink();
    const old = { ...record("9".repeat(32)), context: { ...record("9".repeat(32)).context, version: "0.1.0", build: "0.1.0+oldsha", channel: "demo" as const } };
    await reporterFor(s).send(buildReport(old, options));
    expect(s.requests[0]!.items[0]!.payload).toMatchObject({ release: "terno@0.1.0+oldsha", environment: "demo" });
  });
});
