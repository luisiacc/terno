/**
 * The web's local diagnostics host against a real (fake) IndexedDB shared by
 * two "tabs": what one captures survives what the other writes, and a
 * capture made while a tab is still opening its store isn't lost.
 */
import type { ErrorRecord } from "@terno/core/diag";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openDiagDb, readRecords, writeBatch } from "./diag-store";

const g = globalThis as Record<string, unknown>;
let LocalDiag: typeof import("./diag-local").LocalDiag;
beforeAll(async () => {
  const store = new Map<string, string>();
  g.window ??= { addEventListener() {} };
  g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  ({ LocalDiag } = await import("./diag-local"));
});

let seq = 0;
const record = (ts = Date.now() - 1000 + ++seq): ErrorRecord => ({
  id: (++seq).toString(16).padStart(32, "0"),
  ts,
  kind: "error",
  proc: "renderer",
  code: "ui.boundary",
  fatal: false,
  crumbs: [],
  context: { version: "0.1.0", build: "0.1.0+abc", channel: "test", session: "s", os: "web" },
});

describe("LocalDiag", () => {
  it("a tab that opened earlier never deletes the record another tab captured since (review finding 2)", async () => {
    const factory = new IDBFactory();
    const tabB = new LocalDiag();
    await tabB.open(factory);
    const tabA = new LocalDiag();
    await tabA.open(factory);
    const fromA = record();
    tabA.capture(fromA);
    tabA.flush();
    await tabA.idle();
    const fromB = record();
    tabB.capture(fromB);
    tabB.flush();
    await tabB.idle();
    const db = await openDiagDb(factory);
    expect((await readRecords(db)).map((r) => r.id).sort()).toEqual([fromA.id, fromB.id].sort());
  });

  it("an error captured while the store is still opening is kept, in memory and on disk (review finding 8)", async () => {
    const factory = new IDBFactory();
    const earlier = record(Date.now() - 60_000);
    await writeBatch(await openDiagDb(factory), [], [earlier]);
    const tab = new LocalDiag();
    const opening = tab.open(factory);
    const meanwhile = record();
    tab.capture(meanwhile);
    await opening;
    expect(tab.records.map((r) => r.id)).toEqual([meanwhile.id, earlier.id]);
    await tab.idle();
    expect((await readRecords(await openDiagDb(factory))).map((r) => r.id)).toEqual([meanwhile.id, earlier.id]);
  });
});

describe("sending (plan 78)", () => {
  const requests: string[] = [];
  let respond: () => Promise<Response> = async () => new Response("{}", { status: 200 });
  let Sending: typeof import("./diag-local").LocalDiag;
  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SENTRY_DSN", "http://key@127.0.0.1:9/1");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      requests.push(url);
      return respond();
    });
    ({ LocalDiag: Sending } = await import("./diag-local"));
  });
  afterEach(() => {
    requests.length = 0;
    respond = async () => new Response("{}", { status: 200 });
  });

  it("local mode with ask offers Send, sends nothing on its own, and sends what the user approved", async () => {
    const tab = new Sending();
    tab.setPolicy({ localMode: true, errorReports: "ask" });
    const r = record();
    tab.capture(r);
    expect(tab.view().reporting.offer).toBe("ask");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);
    expect(await tab.decide([r.id], "send")).toEqual({ sent: 1 });
    expect(requests).toEqual([`http://127.0.0.1:9/api/1/envelope/?sentry_version=7&sentry_key=key&sentry_client=${encodeURIComponent("terno/0.0.0")}`]);
    expect(tab.view().pending.find((p) => p.id === r.id)).toBeUndefined();
  });

  it("a report that couldn't go stays pending, to send again", async () => {
    const tab = new Sending();
    tab.setPolicy({ localMode: true, errorReports: "ask" });
    const r = record();
    tab.capture(r);
    respond = async () => new Response("", { status: 503 });
    expect(await tab.decide([r.id], "send")).toEqual({ sent: 0 });
    expect(tab.view().pending.map((p) => p.id)).toContain(r.id);
    respond = async () => new Response("{}", { status: 200 });
    expect(await tab.decide([r.id], "send")).toEqual({ sent: 1 });
    expect(tab.view().pending.map((p) => p.id)).not.toContain(r.id);
  });

  it("Always plus the explicit send of the same reports posts each once (review finding 4)", async () => {
    const tab = new Sending();
    tab.setPolicy({ localMode: true, errorReports: "ask" });
    const r = record();
    tab.capture(r);
    tab.setPolicy({ localMode: true, errorReports: "always" });
    await tab.decide([r.id], "send");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
  });
});

describe("diagnostics copy", () => {
  afterEach(() => setLocale("en", en));

  it("the web export's readme is in the language of the moment it's made; its fields stay fixed", async () => {
    const tab = new LocalDiag();
    const english = JSON.parse(await tab.exportJson()) as Record<string, unknown>;
    setLocale("es", es);
    const spanish = JSON.parse(await tab.exportJson()) as Record<string, unknown>;
    expect(Object.keys(spanish)).toEqual(["readme", "system", "entries", "records"]);
    expect(Object.keys(english)).toEqual(Object.keys(spanish));
    expect(english.readme).toMatch(/^Terno diagnostics: this tab’s logs/);
    expect(spanish.readme).toMatch(/^Diagnóstico de Terno: registros/);
  });

  it("counts are plural messages in both languages", () => {
    expect(t("diag.row.problems", { count: 3 })).toBe("Terno ran into 3 problems");
    expect(t("diag.sent", { count: 1 })).toBe("Report sent. Thank you.");
    expect(t("diag.sent", { count: 2 })).toBe("2 reports sent. Thank you.");
    setLocale("es", es);
    expect(t("diag.row.problems", { count: 3 })).toBe("Terno tuvo 3 problemas");
    expect(t("diag.sent", { count: 1 })).toBe("Informe enviado. Gracias.");
    expect(t("diag.sent", { count: 2 })).toBe("2 informes enviados. Gracias.");
  });
});

