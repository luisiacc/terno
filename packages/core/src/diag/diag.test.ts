import { describe, expect, it, vi } from "vitest";
import { breadcrumb, breadcrumbs, captureError, installDiag, log, sanitizeFields, type DiagSink } from "./diag";
import { appRelative, isExpected, normalizeError, parseStack, UserFacingError } from "./error";
import { mayReport, reportOffer, reportsAutomatically, type ErrorReports } from "./consent";
import { REDACTED, sanitizeField } from "./fields";
import { buildReport } from "./report";
import { Ring } from "./ring";
import { RotatingLog, type RotatingFs } from "./rotating";
import { scrubText } from "./scrub";
import type { DiagEntry, ErrorRecord } from "./types";
import { sanitizeEntry, sanitizeRecord } from "./validate";

/** Strings that must never survive: what a mailbox, a provider or a key looks like. */
const HOSTILE = {
  email: "luis.perez+facturas@empresa.com.mx",
  angle: "Ana López <ana.lopez@example.org>",
  bearer: "Authorization: Bearer ya29.a0AfH6SMBx3kQz9-LONGTOKENVALUE_1234567890",
  oauthUrl: "https://oauth2.googleapis.com/token?code=4/0AY0e-g7abcdefghijkl&client_secret=GOCSPX-supersecret",
  apiKey: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  openai: "using key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234 for chat",
  imapLogin: 'A1 LOGIN "luis@empresa.mx" "hunter2!"',
  imapGreeting: "* OK [CAPABILITY IMAP4rev1] Dovecot ready, user luis.perez@empresa.mx logged in",
  xoauth: "AUTHENTICATE XOAUTH2 dXNlcj1sdWlzQGdtYWlsLmNvbQFhdXRoPUJlYXJlciB5YTI5LmFiYwEB",
  messageId: "In-Reply-To: <CAFk9x2-AbC+123@mail.gmail.com>",
  home: "ENOENT: no such file or directory, open '/Users/luisperez/Documents/Contrato firmado.pdf'",
  jwt: "token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  base64: "attachment data JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0Zp",
  pem: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  password: "password=Tr0ub4dor&3 sent",
};
const NEVER = ["luis", "perez", "empresa", "ana.lopez", "López", "hunter2", "supersecret", "LONGTOKENVALUE", "AbCdEfGh", "Contrato", "CAFk9x2", "Tr0ub4dor", "MIIEvQ", "dXNlcj1s", "JVBERi0x", "ABCDEFGHIJKLMNOP", "eyJzdWIi"];

describe("scrubText", () => {
  it.each(Object.entries(HOSTILE))("%s leaves nothing identifying", (_name, input) => {
    const out = scrubText(input);
    for (const s of NEVER) expect(out).not.toContain(s);
  });

  it("keeps what helps: error codes, hosts, numbers", () => {
    expect(scrubText("connect ECONNREFUSED 127.0.0.1:993")).toBe("connect ECONNREFUSED 127.0.0.1:993");
    expect(scrubText("GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:ana failed (429)")).toBe("GET https://gmail.googleapis.com/… failed (429)");
  });

  it("cannot forge a log line, and is capped", () => {
    expect(scrubText('ok\n{"level":"fatal"}')).not.toContain("\n");
    expect(scrubText("x".repeat(2000)).length).toBeLessThan(520);
  });
});

describe("fields", () => {
  it("keep only what fits each type", () => {
    expect(sanitizeField("accountKind", "imap")).toBe("imap");
    expect(sanitizeField("accountKind", "Facturas de Ana")).toBe("other");
    expect(sanitizeField("errorClass", "TypeError")).toBe("TypeError");
    expect(sanitizeField("errorClass", "Re: tu factura de octubre")).toBe(REDACTED);
    expect(sanitizeField("count", 12.6)).toBe(13);
    expect(sanitizeField("count", -4)).toBe(0);
    expect(sanitizeField("count", "12")).toBeUndefined();
    expect(sanitizeField("retryable", "yes")).toBeUndefined();
    expect(sanitizeField("method", "threads.list")).toBe("threads.list");
    expect(sanitizeField("method", "drop table")).toBe(REDACTED);
  });

  it("drop keys the code didn't declare, at runtime as at compile time", () => {
    const f = sanitizeFields("sync.failed", { accountKind: "gmail", subject: "Hola", email: HOSTILE.email, retryable: true });
    expect(f).toEqual({ accountKind: "gmail", retryable: true });
    // @ts-expect-error count is a number
    const typeOnly = () => log.info("export.done", { count: "many" });
    expect(typeOf(typeOnly)).toBe("function");
  });
});

const typeOf = (v: unknown) => typeof v;

describe("Ring", () => {
  it("keeps the last N, oldest first", () => {
    const r = new Ring<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
    expect(r.pushed).toBe(5);
  });
});

describe("errors", () => {
  it("frames are app-relative: no user name, no machine path", () => {
    expect(appRelative("/Applications/Terno.app/Contents/Resources/app.asar/dist/main.cjs")).toBe("dist/main.cjs");
    expect(appRelative("file:///Users/luis/projects/emailclient/apps/desktop/dist/backend.cjs")).toBe("dist/backend.cjs");
    expect(appRelative("app://terno/assets/index-B2k.js")).toBe("renderer/assets/index-B2k.js");
    expect(appRelative("https://terno.app/assets/index-B2k.js?v=1")).toBe("assets/index-B2k.js");
    expect(appRelative("/Users/luis/Desktop/random.js")).toBe("random.js");
    expect(appRelative("node:internal/process/task_queues")).toBe("node:internal/process/task_queues");
  });

  it("parses V8 and WebKit stacks", () => {
    const v8 = parseStack("TypeError: x\n    at Foo.bar (/Applications/Terno.app/Contents/Resources/app.asar/dist/main.cjs:12:345)\n    at async Promise.all (index 0)\n    at /x/app.asar/dist/backend.cjs:1:2");
    expect(v8[0]).toEqual({ fn: "Foo.bar", file: "dist/main.cjs", line: 12, col: 345 });
    expect(v8.at(-1)).toEqual({ file: "dist/backend.cjs", line: 1, col: 2 });
    expect(parseStack("render@app://terno/assets/index.js:3:9")[0]).toEqual({ fn: "render", file: "renderer/assets/index.js", line: 3, col: 9 });
    // the message line is never a frame, even with an address in it
    expect(parseStack("Error: no reply from luis@empresa.mx\n    at x (/a/app.asar/dist/main.cjs:1:1)")).toEqual([{ fn: "x", file: "dist/main.cjs", line: 1, col: 1 }]);
  });

  it("normalizes anything thrown, scrubbing its text", () => {
    const n = normalizeError(new Error(`could not send to ${HOSTILE.email}`));
    expect(n.name).toBe("Error");
    expect(n.message).not.toContain("luis");
    expect(n.frames.length).toBeGreaterThan(0);
    expect(normalizeError("plain string").name).toBe("NonString");
    expect(normalizeError({ subject: "x" }).name).toBe("NonObject");
  });

  it("tells user errors from bugs", () => {
    expect(isExpected(new UserFacingError("sync.failed", "Contraseña incorrecta"))).toBe(true);
    expect(isExpected(Object.assign(new Error("401"), { expected: true }))).toBe(true);
    expect(isExpected(Object.assign(new Error("stop"), { name: "AbortError" }))).toBe(true);
    expect(isExpected(new TypeError("undefined is not a function"))).toBe(false);
    expect(isExpected("text")).toBe(false);
  });
});

function memorySink() {
  const entries: DiagEntry[] = [];
  const records: ErrorRecord[] = [];
  const mirrors: number[] = [];
  let flushed = 0;
  const sink: DiagSink = { write: (e) => entries.push(e), capture: (r) => records.push(r), mirror: (c) => mirrors.push(c.length), flush: () => flushed++ };
  return { sink, entries, records, mirrors, flushed: () => flushed };
}

describe("log, breadcrumb, captureError", () => {
  it("writes one sanitized entry per call and leaves a crumb", () => {
    const m = memorySink();
    installDiag({ proc: "backend", version: "1.2.3", build: "1.2.3+abc", channel: "test", session: "s1", sink: m.sink });
    log.warn("sync.failed", { accountKind: "imap", retryable: true }, `login failed for ${HOSTILE.email}`);
    expect(m.entries[0]).toMatchObject({ level: "warn", proc: "backend", code: "sync.failed", fields: { accountKind: "imap", retryable: true }, session: "s1", version: "1.2.3" });
    expect(m.entries[0]!.msg).not.toContain("luis");
    breadcrumb("nav", "nav.view", { view: "inbox" });
    expect(breadcrumbs().map((c) => c.code)).toEqual(["sync.failed", "nav.view"]);
  });

  it("expected errors are logged, never recorded", () => {
    const m = memorySink();
    installDiag({ proc: "backend", version: "1", build: "1", channel: "test", sink: m.sink });
    expect(captureError(new UserFacingError("sync.failed", "wrong password"), { code: "sync.failed", fields: { accountKind: "imap" } })).toBeNull();
    expect(m.records).toHaveLength(0);
    expect(m.entries[0]).toMatchObject({ level: "warn", code: "sync.failed", fields: { errorClass: "UserFacingError", accountKind: "imap" } });
  });

  it("an unexpected error becomes one record with crumbs and context; repeats are counted, fatal flushes", () => {
    const m = memorySink();
    installDiag({ proc: "renderer", version: "1", build: "1", channel: "test", sink: m.sink, context: () => ({ os: "darwin", arch: "arm64" }) });
    breadcrumb("action", "action.thread", { action: "archive", count: 3 });
    const boom = () => captureError(new TypeError("x is undefined"), { code: "ui.boundary", fields: { area: "reader" } });
    const id = boom();
    expect(boom()).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(m.records).toHaveLength(1);
    expect(m.records[0]).toMatchObject({ id, kind: "error", proc: "renderer", code: "ui.boundary", fatal: false, fields: { area: "reader", errorClass: "TypeError" }, count: 2, context: { os: "darwin", arch: "arm64", version: "1" } });
    expect(m.records[0]!.crumbs.map((c) => c.code)).toContain("action.thread");
    captureError(new Error("dead"), { code: "process.uncaught", fatal: true });
    expect(m.records[1]).toMatchObject({ kind: "crash", fatal: true });
    expect(m.flushed()).toBe(1);
  });

  it("mirrors the ring every 20 crumbs", () => {
    const m = memorySink();
    installDiag({ proc: "renderer", version: "1", build: "1", channel: "test", sink: m.sink, mirrorEveryMs: 1e9 });
    for (let i = 0; i < 45; i++) breadcrumb("nav", "nav.thread", { threadId: i });
    expect(m.mirrors.length).toBe(2);
  });

  it("a quiet process mirrors its last crumbs once, then holds no timer (idle is idle)", () => {
    vi.useFakeTimers();
    try {
      const m = memorySink();
      installDiag({ proc: "backend", version: "1", build: "1", channel: "test", sink: m.sink, now: () => Date.now() });
      breadcrumb("sync", "sync.done", { accountKind: "imap" });
      expect(m.mirrors).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      expect(m.mirrors).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sink that throws never reaches the caller", () => {
    installDiag({ proc: "main", version: "1", build: "1", channel: "test", sink: { write: () => { throw new Error("disk full"); }, capture: () => { throw new Error("disk full"); } } });
    expect(() => log.error("export.failed", { errno: "ENOSPC" })).not.toThrow();
    expect(() => captureError(new Error("x"), { code: "export.failed" })).not.toThrow();
  });

  it("a hot-path log call costs a few microseconds", () => {
    installDiag({ proc: "backend", version: "1", build: "1", channel: "test", sink: { write: () => {}, capture: () => {} } });
    const n = 20_000;
    const t = performance.now();
    for (let i = 0; i < n; i++) log.info("rpc.call", { method: "threads.list", durationMs: i % 50, ok: true });
    expect(((performance.now() - t) * 1000) / n).toBeLessThan(20);
  });
});

describe("consent", () => {
  const settings: ErrorReports[] = ["ask", "always", "never"];
  it.each(settings.flatMap((errorReports) => [true, false].flatMap((localMode) => [true, false].flatMap((dsn) => [true, false].map((approved) => ({ errorReports, localMode, dsn, approved }))))))(
    "%o",
    ({ errorReports, localMode, dsn, approved }) => {
      const expected = dsn && !localMode && (errorReports === "always" || (errorReports === "ask" && approved));
      expect(mayReport({ errorReports, localMode, dsn }, approved)).toBe(expected);
      expect(reportsAutomatically({ errorReports, localMode, dsn })).toBe(dsn && !localMode && errorReports === "always");
    },
  );
  it("offers export instead in local mode, without a DSN, or when never", () => {
    expect(reportOffer({ errorReports: "always", localMode: true, dsn: true })).toBe("local");
    expect(reportOffer({ errorReports: "ask", localMode: false, dsn: false })).toBe("local");
    expect(reportOffer({ errorReports: "never", localMode: false, dsn: true })).toBe("local");
    expect(reportOffer({ errorReports: "ask", localMode: false, dsn: true })).toBe("ask");
    expect(reportOffer({ errorReports: "always", localMode: false, dsn: true })).toBe("sent");
  });
});

describe("buildReport", () => {
  const record: ErrorRecord = {
    id: "0123456789abcdef0123456789abcdef",
    ts: 1_700_000_000_000,
    kind: "error",
    proc: "backend",
    code: "sync.failed",
    fields: { accountKind: "imap", errorClass: "TypeError" },
    fatal: false,
    error: { name: "TypeError", message: `Cannot read properties of undefined (reading 'from') for ${HOSTILE.email}`, frames: [{ fn: "a", file: "dist/backend.cjs", line: 1, col: 2 }, { file: "dist/backend.cjs", line: 9, col: 9 }] },
    crumbs: [{ ts: 1_699_999_999_000, cat: "sync", code: "sync.done", level: "info", fields: { accountKind: "gmail", durationMs: 120 } }],
    context: { version: "0.1.0", build: "0.1.0+abc1234", channel: "production", session: "sess1", os: "darwin", osVersion: "25.6.0", arch: "arm64", locale: "es-MX", runtime: "electron-45.0.0", uptimeS: 30, accounts: { imap: 1, gmail: 2 } },
    debugIds: { "dist/backend.cjs": "11111111-2222-4333-8444-555555555555" },
  };

  it("carries codes, classes and frames, never the message", () => {
    const event = buildReport(record, { installId: "inst", release: "terno@0.1.0+abc1234", environment: "production" });
    const json = JSON.stringify(event);
    expect(json).not.toContain("Cannot read");
    expect(json).not.toContain("luis");
    expect(event.exception.values[0]).toMatchObject({ type: "TypeError", value: "sync.failed", mechanism: { handled: true } });
    // outermost first for Sentry
    expect(event.exception.values[0]!.stacktrace!.frames.map((f) => f.lineno)).toEqual([9, 1]);
    expect(event.debug_meta?.images[0]).toEqual({ type: "sourcemap", code_file: "app:///dist/backend.cjs", debug_id: "11111111-2222-4333-8444-555555555555" });
    expect(event.breadcrumbs[0]).toMatchObject({ category: "sync", message: "sync.done", data: { accountKind: "gmail", durationMs: 120 } });
    expect(event.user).toEqual({ id: "inst" });
    expect(event.tags).toMatchObject({ proc: "backend", code: "sync.failed", session: "sess1" });
  });

  it("a record forged by a renderer is cut back to the schema", () => {
    const forged = { ...record, proc: "main", fields: { accountKind: "imap", subject: "Hola Ana" }, error: { name: "Re: factura", message: HOSTILE.bearer, frames: [{ file: "/Users/luis/x.js", fn: "Ana López" }] }, debugIds: { "dist/x.js": "not-a-uuid" } };
    const clean = sanitizeRecord(forged, "renderer")!;
    expect(clean.proc).toBe("renderer");
    expect(clean.fields).toEqual({ accountKind: "imap" });
    expect(clean.error!.name).toBe("Error");
    expect(clean.error!.message).not.toContain("ya29");
    expect(clean.error!.frames[0]).toEqual({ file: "<redacted>" });
    expect(clean.debugIds).toBeUndefined();
    expect(sanitizeEntry({ ts: 1, level: "info", code: "nope", session: "s", version: "v", build: "b" }, "renderer")).toBeNull();
  });
});

describe("RotatingLog", () => {
  function memFs(failAppend = false) {
    const files = new Map<string, string>();
    const fs: RotatingFs = {
      appendFile: async (p, d) => {
        if (failAppend) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        files.set(p, (files.get(p) ?? "") + d);
      },
      appendFileSync: (p, d) => void files.set(p, (files.get(p) ?? "") + d),
      size: async (p) => files.get(p)?.length ?? 0,
      sizeSync: (p) => files.get(p)?.length ?? 0,
      rename: async (a, b) => {
        if (!files.has(a)) throw new Error("ENOENT");
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      renameSync: (a, b) => {
        if (!files.has(a)) throw new Error("ENOENT");
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      remove: async (p) => void files.delete(p),
      removeSync: (p) => void files.delete(p),
    };
    return { fs, files };
  }

  it("rotates at the cap and keeps N files", async () => {
    const { fs, files } = memFs();
    const logFile = new RotatingLog("main.jsonl", fs, { maxBytes: 100, maxFiles: 3, delayMs: 0 });
    for (let i = 0; i < 20; i++) {
      logFile.write(`{"i":${i},"pad":"${"x".repeat(20)}"}`);
      await logFile.flush();
    }
    expect([...files.keys()].sort()).toEqual(["main.jsonl", "main.jsonl.1", "main.jsonl.2"]);
    for (const v of files.values()) expect(v.length).toBeLessThanOrEqual(100);
    expect(files.get("main.jsonl")).toContain('"i":19');
  });

  it("flushSync writes what is queued at once", () => {
    const { fs, files } = memFs();
    const logFile = new RotatingLog("b.jsonl", fs, { delayMs: 10_000 });
    logFile.write("a");
    logFile.write("b");
    logFile.flushSync();
    expect(files.get("b.jsonl")).toBe("a\nb\n");
  });

  it("a full disk drops the batch silently", async () => {
    const { fs } = memFs(true);
    const errors: unknown[] = [];
    const logFile = new RotatingLog("c.jsonl", fs, { delayMs: 0, onError: (e) => errors.push(e) });
    logFile.write("x");
    await expect(logFile.flush()).resolves.toBeUndefined();
    expect(logFile.dropped).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
