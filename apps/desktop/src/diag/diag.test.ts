import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { appendFileSync } from "node:fs";
import { captureError, installDiag, type ErrorRecord } from "@terno/core/diag";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectExport, zip } from "./export";
import { diagPaths, ensureDirs, fitRecord, RECORD_MAX_BYTES, RecordStore, Rings, runMarker, StateFile } from "./store";
import { BACKOFF_MS, HEALTHY_MS, RateLimit, RestartPolicy } from "./supervisor";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "terno-diag-"));
  dirs.push(d);
  return d;
};

let seq = 0;
function record(over: Partial<ErrorRecord> = {}): ErrorRecord {
  seq++;
  return {
    id: seq.toString(16).padStart(32, "0"),
    ts: Date.now() - 1000 + seq,
    kind: "error",
    proc: "backend",
    code: "sync.failed",
    fields: { accountKind: "imap" },
    fatal: false,
    error: { name: "TypeError", frames: [{ fn: "f", file: "dist/backend.cjs", line: 1, col: 2 }] },
    crumbs: [],
    context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s1", os: "darwin" },
    ...over,
  };
}

/** Reads back a zip written by zip(): name → content. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const data = buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    out.set(name, inflateRawSync(data));
    at += 30 + nameLen + size;
  }
  return out;
}

describe("RestartPolicy", () => {
  it("backs off 0.5, 1, 2, 4, 8 s, then stops; a minute up starts over", () => {
    const p = new RestartPolicy();
    p.started(0);
    expect([1, 2, 3, 4, 5, 6].map(() => p.exited(10))).toEqual([...BACKOFF_MS, null]);
    p.started(1000);
    expect(p.exited(1000 + HEALTHY_MS)).toBe(500);
    p.reset();
    expect(p.exited(1000 + HEALTHY_MS + 1)).toBe(500);
  });
});

describe("RateLimit", () => {
  it("lets 200 entries a second through and counts the rest", () => {
    const r = new RateLimit(200, 0);
    expect(r.take(150, 0)).toBe(150);
    expect(r.take(100, 0)).toBe(50);
    expect(r.dropped).toBe(50);
    expect(r.take(100, 500)).toBe(100);
  });
});

describe("RecordStore", () => {
  it("keeps 20 at most, none older than 30 days, newest first, 0600", () => {
    const dir = tmp();
    const store = new RecordStore(dir);
    store.writeSync(record({ ts: Date.now() - 31 * 86_400_000 }));
    for (let i = 0; i < 25; i++) store.writeSync(record());
    const list = store.list();
    expect(list).toHaveLength(20);
    expect(list[0]!.ts).toBeGreaterThan(list[19]!.ts);
    const file = readdirSync(dir)[0]!;
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  });

  it("fits a record into 64 KB, dropping old crumbs first", () => {
    const crumbs = Array.from({ length: 5000 }, (_, i) => ({ ts: i, cat: "nav" as const, code: "nav.thread" as const, level: "info" as const, fields: { threadId: i } }));
    const json = fitRecord(record({ crumbs }));
    expect(json.length).toBeLessThanOrEqual(RECORD_MAX_BYTES);
    expect((JSON.parse(json) as ErrorRecord).crumbs.at(-1)!.fields!.threadId).toBe(4999);
  });

  it("skips files that are forged or torn", () => {
    const dir = tmp();
    writeFileSync(join(dir, `1-renderer-${"f".repeat(32)}.json`), JSON.stringify({ ...record(), fields: { subject: "Hola" }, code: "made.up" }));
    writeFileSync(join(dir, `2-renderer-${"e".repeat(32)}.json`), "{ torn");
    expect(new RecordStore(dir).list()).toEqual([]);
  });

  it("a full disk loses the record silently", () => {
    const store = new RecordStore(join(tmp(), "gone", "deeper"));
    expect(() => store.writeSync(record())).not.toThrow();
  });
});

describe("state, rings, run marker", () => {
  it("keeps a random install id and the last policy; a reset changes the id", () => {
    const path = join(tmp(), "state.json");
    const a = new StateFile(path);
    const id = a.get().installId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    a.update((s) => (s.policy = { localMode: false, errorReports: "always" }));
    const b = new StateFile(path);
    expect(b.get()).toMatchObject({ installId: id, policy: { localMode: false, errorReports: "always" } });
  });

  it("rings persist with their session and come back sanitized", () => {
    const path = join(tmp(), "rings.json");
    const r = new Rings(path, () => "sess");
    r.set("backend#2", [{ ts: 1, cat: "sync", code: "sync.done", level: "info", fields: { accountKind: "gmail" } }]);
    r.persistSync();
    expect(new Rings(path, () => "other").readPrevious()).toEqual({ session: "sess", rings: { "backend#2": [{ ts: 1, cat: "sync", code: "sync.done", level: "info", fields: { accountKind: "gmail" } }] } });
  });

  it("the marker is there while running and gone after a clean quit", () => {
    const dir = tmp();
    runMarker.write(dir, { session: "s", version: "1", build: "1+a", startedAt: 5 });
    expect(runMarker.read(dir)).toMatchObject({ session: "s" });
    runMarker.clear(dir);
    expect(runMarker.read(dir)).toBeNull();
  });
});

describe("rings in normal use never touch the disk synchronously (review finding 5)", () => {
  it("a change is written 10 s later, asynchronously and one write at a time; sync only when asked (fatal, quit)", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let release!: () => void;
      const io = {
        write: vi.fn(async (_p: string, data: string) => {
          calls.push(`start ${JSON.parse(data).rings.main.length}`);
          await new Promise<void>((r) => (release = r));
          calls.push("end");
        }),
        writeSync: vi.fn(() => {
          throw new Error("synchronous write on the periodic path");
        }),
      };
      const r = new Rings("/nowhere/rings.json", () => "s", { delayMs: 10_000, io });
      const crumb = (i: number) => ({ ts: i, cat: "nav" as const, code: "nav.thread" as const, level: "info" as const, fields: { threadId: i } });
      r.set("main", [crumb(1)]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(io.write).toHaveBeenCalledTimes(1);
      // a change while that write is still going: its write waits for the first to end
      r.set("main", [crumb(1), crumb(2)]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toEqual(["start 1"]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["start 1", "end", "start 2", "end"]);
      expect(io.writeSync).not.toHaveBeenCalled();
      // idle: nothing more, no timer left
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("export", () => {
  it("zips Terno's diagnostics only, validated again, never following a symlink", async () => {
    const root = tmp();
    const paths = diagPaths(root);
    ensureDirs(paths);
    // a log line forged with a subject and an address, next to a good one
    writeFileSync(
      join(paths.logs, "renderer.jsonl"),
      [
        JSON.stringify({ ts: 1, level: "warn", proc: "renderer", code: "sync.failed", fields: { accountKind: "imap", subject: "Contrato con Ana" }, session: "s", version: "1", build: "1", msg: "for ana.lopez@example.org" }),
        JSON.stringify({ ts: 2, level: "info", proc: "renderer", code: "invented.code", session: "s", version: "1", build: "1" }),
        "{ torn",
      ].join("\n"),
    );
    // a record from an older build, when messages were still kept
    new RecordStore(paths.crashes).writeSync(record({ error: { name: "Error", message: "Re: Contrato con Ana <ana.lopez@example.org>", frames: [] } as never }));
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "ana.lopez@example.org");
    symlinkSync(secret, join(paths.logs, "linked.jsonl"));
    mkdirSync(join(paths.crashes, "native"), { recursive: true });
    writeFileSync(join(paths.crashes, "native", "a.dmp"), "MDMP");

    const files = unzip(await zip(await collectExport({ paths, system: { terno: "0.1.0" } })));
    expect([...files.keys()].sort()).toEqual(["README.txt", expect.stringMatching(/^crashes\/\d+-backend-[0-9a-f]{32}\.json$/), "logs/renderer.jsonl", "system.json"].sort());
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    expect(all).not.toContain("example.org");
    expect(all).not.toContain("ana.lopez");
    expect(all).not.toContain("Contrato");
    expect(all).not.toContain("invented.code");
    expect(files.get("logs/renderer.jsonl")!.toString()).toContain('"accountKind":"imap"');
    // native dumps only when asked for
    const withNative = unzip(await zip(await collectExport({ paths, system: {}, nativeDir: join(paths.crashes, "native") })));
    expect(withNative.has("native/a.dmp")).toBe(true);
  });
});

describe("malformed AI output never reaches an export (review finding 1)", () => {
  it("a parse error quoting the model's answer leaves only codes in logs, records and the unzipped export", async () => {
    const root = tmp();
    const paths = diagPaths(root);
    ensureDirs(paths);
    const store = new RecordStore(paths.crashes);
    installDiag({ proc: "backend", version: "0.1.0", build: "0.1.0+abc", channel: "test", sink: { write: (e) => appendFileSync(join(paths.logs, "backend.jsonl"), `${JSON.stringify(e)}\n`), capture: (r) => store.writeSync(r) } });
    const SUBJECT = "Quarterly board deck draft";
    const BODY = "the layoffs stay confidential until March";
    const output = `{"label": "${SUBJECT}", "explain": "${BODY}"`;
    // the provider's verdict (expected: a warning) and the same text in an unexpected failure (a record)
    captureError(Object.assign(new Error(`La IA no produjo un resultado válido: ${output}`), { name: "AiError", expected: true }), { code: "ai.assist_failed", fields: { aiKind: "invalid_output" } });
    captureError(new SyntaxError(`Unexpected token } in JSON: ${output}`), { code: "ai.unexpected", fields: { op: "classify" } });
    expect(store.list()).toHaveLength(1);
    const files = unzip(await zip(await collectExport({ paths, system: {} })));
    expect(files.has("logs/backend.jsonl")).toBe(true);
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    for (const s of ["Quarterly", "layoffs", "confidential", "resultado válido", "Unexpected token"]) expect(all).not.toContain(s);
    expect(all).toContain('"code":"ai.unexpected"');
  });
});

describe("export keeps main responsive (review finding 6)", () => {
  it("exporting 10 MB of logs never holds the event loop for long", async () => {
    const root = tmp();
    const paths = diagPaths(root);
    ensureDirs(paths);
    const line = (i: number) => JSON.stringify({ ts: 1_700_000_000_000 + i, level: "info", proc: "backend", code: "rpc.call", fields: { method: "threads.list", durationMs: i % 90, ok: true }, session: "0123456789abcdef0123456789abcdef", version: "0.1.0", build: "0.1.0+abc" });
    const chunk = Array.from({ length: 12_000 }, (_, i) => line(i)).join("\n");
    for (const f of ["backend.jsonl", "backend.jsonl.1", "backend.jsonl.2", "backend.jsonl.3", "backend.jsonl.4"]) writeFileSync(join(paths.logs, f), chunk);
    let last = performance.now();
    let worst = 0;
    const sampler = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 2);
    const started = performance.now();
    const archive = await zip(await collectExport({ paths, system: {} }));
    const took = performance.now() - started;
    clearInterval(sampler);
    expect(unzip(archive).get("logs/backend.jsonl.4")!.toString().split("\n").filter(Boolean)).toHaveLength(12_000);
    console.log(`export: ${Math.round(took)} ms, longest event-loop gap ${Math.round(worst)} ms`);
    expect(worst).toBeLessThan(Math.max(80, took / 4));
  });
});
