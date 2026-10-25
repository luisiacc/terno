import type { UpdateState } from "@terno/core/updates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, UpdateController, type ControllerDeps, type InstallShutdown } from "./controller";
import type { Engine, EngineHandlers, EngineInfo } from "./engine";
import { DEFAULT_PREFS, type PendingInstall, type UpdatePrefs } from "./policy";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const DELAY = 30_000;
const GITHUB = "https://github.com/luisiacc/terno/releases.atom";

interface Harness {
  ctl: UpdateController;
  deps: ControllerDeps;
  engine: FakeEngine;
  loads: number;
  published: UpdateState[];
  logs: [string, unknown][];
  captures: [string, Record<string, unknown>, boolean][];
  pending: PendingInstall | null;
  prefs: UpdatePrefs;
  shutdowns: number;
  sendsIdle: (() => void)[];
  recovered: number;
  /** what the engine's session would answer for a request right now */
  allowed(url?: string): boolean;
}

interface FakeEngine extends Engine {
  handlers: EngineHandlers | null;
  allowed: ((url: string) => boolean) | null;
  next: EngineInfo | null | Error;
  /** a download in flight: resolve or reject it */
  dl: { resolve(): void; reject(e: Error): void } | null;
  cancelled: number;
  installs: number;
}

const release = (version: string): EngineInfo => ({ version, releaseNotes: "<p>Faster</p>", releaseDate: null, size: 1000 });

function harness(o: { localMode?: boolean; prefs?: Partial<UpdatePrefs>; unsupported?: "dmg" | null; shutdown?: InstallShutdown[]; pending?: PendingInstall | null; version?: string } = {}): Harness {
  const engine: FakeEngine = {
    handlers: null,
    allowed: null,
    next: null,
    dl: null,
    cancelled: 0,
    installs: 0,
    async check() {
      const n = engine.next;
      if (n instanceof Error) throw n;
      return n;
    },
    download() {
      return new Promise<void>((resolve, reject) => (engine.dl = { resolve, reject }));
    },
    cancel() {
      engine.cancelled++;
      engine.dl?.reject(Object.assign(new Error("cancelled"), { name: "CancellationError" }));
    },
    quitAndInstall() {
      engine.installs++;
    },
  };
  const outcomes = [...(o.shutdown ?? ["closed"])];
  const h: Harness = {
    ctl: null as unknown as UpdateController,
    deps: null as unknown as ControllerDeps,
    engine,
    loads: 0,
    published: [],
    logs: [],
    captures: [],
    pending: o.pending ?? null,
    prefs: { ...DEFAULT_PREFS, ...o.prefs },
    shutdowns: 0,
    sendsIdle: [],
    recovered: 0,
    allowed: (url = GITHUB) => engine.allowed?.(url) ?? false,
  };
  h.deps = {
    version: o.version ?? "0.1.0",
    feed: { provider: "github", owner: "luisiacc", repo: "terno" },
    testFeed: null,
    checkDelayMs: DELAY,
    loadEngine: ({ allowed, handlers }) => {
      h.loads++;
      engine.allowed = allowed;
      engine.handlers = handlers;
      return engine;
    },
    probe: async () => o.unsupported ?? null,
    prefs: { read: () => h.prefs, write: (p) => (h.prefs = p) },
    pending: { read: () => h.pending, write: (p) => (h.pending = p), clear: () => (h.pending = null) },
    shutdown: async () => {
      h.shutdowns++;
      return outcomes.shift() ?? "closed";
    },
    onSendsIdle: (cb) => h.sendsIdle.push(cb),
    recover: () => h.recovered++,
    publish: (s) => h.published.push(s),
    log: (code, fields) => h.logs.push([code, fields]),
    capture: (_e, code, fields, expected) => h.captures.push([code, fields, expected]),
    newId: () => "tx1",
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  h.ctl = new UpdateController(h.deps, o.localMode ?? false);
  return h;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("main: the update controller", () => {
  it("does nothing at launch: no engine loaded, no request, until the startup delay", async () => {
    const h = harness();
    h.engine.next = null;
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(h.loads).toBe(0);
    expect(h.published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.loads).toBe(1);
    expect(h.ctl.view.status).toBe("up-to-date");
    // the next check in 4 h, and nothing else pending
    expect(vi.getTimerCount()).toBe(1);
  });

  it("automatic mode: checks, downloads in the background, and is ready only once Squirrel accepts the bundle", async () => {
    const h = harness();
    h.engine.next = release("0.2.0");
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.ctl.view.status).toBe("downloading");
    expect(h.allowed()).toBe(true); // the download's grant is open
    h.engine.handlers!.progress(50.4);
    h.engine.handlers!.progress(50.9);
    expect(h.published.filter((s) => s.percent === 50)).toHaveLength(1); // only whole percents go to the windows
    h.engine.dl!.resolve();
    await flush();
    expect(h.ctl.view.status).toBe("verifying");
    expect(h.allowed()).toBe(false); // nothing open: the session refuses everything
    h.engine.handlers!.ready();
    expect(h.ctl.view).toMatchObject({ status: "ready", ready: { version: "0.2.0", notes: "Faster" } });
    // the next automatic check is in 4 h; a newer release then downloads beside the ready one (which stays)
    h.engine.next = release("0.2.1");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(h.ctl.view).toMatchObject({ status: "downloading", ready: { version: "0.2.0" }, available: { version: "0.2.1" } });
  });

  it("manual mode: checks in the background and offers; downloads only when asked", async () => {
    const h = harness({ prefs: { mode: "manual" } });
    h.engine.next = release("0.2.0");
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.ctl.view.status).toBe("available");
    expect(h.engine.dl).toBeNull();
    void h.ctl.download("manual");
    await flush();
    expect(h.ctl.view.status).toBe("downloading");
  });

  describe("local mode", () => {
    it("no automatic check at all: no engine, no timer; the session refuses everything", async () => {
      const h = harness({ localMode: true });
      h.ctl.start();
      await vi.advanceTimersByTimeAsync(DELAY + CHECK_EVERY_MS * 2);
      expect(h.loads).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.published).toEqual([]);
    });

    it("a manual check is one grant, the download a second; neither outlives its request", async () => {
      const h = harness({ localMode: true });
      h.engine.next = release("0.2.0");
      h.ctl.start();
      await vi.advanceTimersByTimeAsync(DELAY);
      const checked = await h.ctl.check("manual");
      expect(checked.status).toBe("available");
      // automatic mode, but local mode: found, not downloaded
      expect(h.engine.dl).toBeNull();
      expect(h.allowed()).toBe(false);
      const downloading = h.ctl.download("manual");
      await flush();
      expect(h.allowed()).toBe(true);
      h.engine.dl!.resolve();
      await downloading;
      expect(h.allowed()).toBe(false);
      // an automatic download is still refused
      expect((await h.ctl.download("auto")).status).toBe("verifying");
    });

    it("turning it on stops automatic work in flight: the download is cancelled, the offer stays, no timer is left", async () => {
      const h = harness();
      h.engine.next = release("0.2.0");
      h.ctl.start();
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(h.ctl.view.status).toBe("downloading");
      h.ctl.setLocalMode(true);
      await flush();
      expect(h.engine.cancelled).toBe(1);
      expect(h.ctl.view).toMatchObject({ status: "available", error: null, localMode: true });
      expect(h.captures).toEqual([]); // a cancellation, not an error
      expect(h.allowed()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // and off again: the automatic check comes back after the delay
      h.engine.next = release("0.2.0");
      h.ctl.setLocalMode(false);
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(h.ctl.view.status).toBe("downloading");
    });

    it("a manual download in local mode is the user's: turning local mode on again doesn't cancel it", async () => {
      const h = harness({ localMode: true, prefs: { mode: "manual" } });
      h.engine.next = release("0.2.0");
      h.ctl.start();
      await h.ctl.check("manual");
      void h.ctl.download("manual");
      await flush();
      h.ctl.setLocalMode(false);
      h.ctl.setLocalMode(true);
      expect(h.engine.cancelled).toBe(0);
      expect(h.allowed()).toBe(true);
    });
  });

  it("only GitHub's release hosts, even with a grant open", async () => {
    const h = harness();
    h.engine.next = release("0.2.0");
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.allowed("https://objects.githubusercontent.com/x")).toBe(true);
    expect(h.allowed("https://evil.example/x.zip")).toBe(false);
    expect(h.logs).toContainEqual(["update.blocked", { reason: "host" }]);
  });

  it("errors: a failed check is expected when offline; a corrupted zip is captured as unexpected; Squirrel's refusal is a verify error", async () => {
    const h = harness();
    h.engine.next = Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), {});
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.ctl.view.error).toEqual({ stage: "check", kind: "offline", canRetry: true });
    expect(h.captures.at(-1)).toEqual(["update.failed", { stage: "check" }, true]);
    h.engine.next = release("0.2.0");
    await h.ctl.check("manual");
    h.engine.dl!.reject(Object.assign(new Error("sha512 checksum mismatch, expected abc, got def"), { code: "ERR_CHECKSUM_MISMATCH" }));
    await flush();
    expect(h.ctl.view).toMatchObject({ status: "available", error: { stage: "download", kind: "integrity", canRetry: true } });
    expect(h.captures.at(-1)).toEqual(["update.failed", { stage: "download" }, false]);
    void h.ctl.download("manual");
    await flush();
    h.engine.dl!.resolve();
    await flush();
    h.engine.handlers!.squirrelError(new Error("Code signature at URL file:///… did not pass validation: SQRLCodeSignatureErrorDomain"));
    expect(h.ctl.view).toMatchObject({ status: "available", ready: null, error: { stage: "verify", kind: "integrity" } });
  });

  describe("installing", () => {
    async function ready(h: Harness) {
      h.engine.next = release("0.2.0");
      h.ctl.start();
      await vi.advanceTimersByTimeAsync(DELAY);
      h.engine.dl!.resolve();
      await flush();
      h.engine.handlers!.ready();
    }

    it("restart: the coordinated shutdown first, then the record, then Squirrel", async () => {
      const h = harness();
      await ready(h);
      await h.ctl.install();
      expect(h.shutdowns).toBe(1);
      expect(h.pending).toMatchObject({ from: "0.1.0", to: "0.2.0", txId: "tx1" });
      expect(h.engine.installs).toBe(1);
      expect(h.ctl.view.status).toBe("installing");
    });

    it("a send past the deadline defers it (never forced); it goes ahead once sends are idle", async () => {
      const h = harness({ shutdown: ["sending", "closed"] });
      await ready(h);
      await h.ctl.install();
      expect(h.ctl.view).toMatchObject({ status: "ready", deferred: "sending" });
      expect(h.engine.installs).toBe(0);
      expect(h.pending).toBeNull();
      expect(h.logs).toContainEqual(["update.deferred", { reason: "sending" }]);
      // asking again while deferred doesn't stack waiters
      await h.ctl.install();
      expect(h.sendsIdle).toHaveLength(1);
      h.sendsIdle[0]!();
      await flush();
      expect(h.engine.installs).toBe(1);
      expect(h.pending?.to).toBe("0.2.0");
    });

    it("Squirrel failing at install: still ready with an install error, the record cleared, the backend brought back", async () => {
      const h = harness();
      await ready(h);
      h.engine.quitAndInstall = () => {
        throw new Error("boom");
      };
      await h.ctl.install();
      expect(h.ctl.view).toMatchObject({ status: "ready", error: { stage: "install", canRetry: true } });
      expect(h.pending).toBeNull();
      expect(h.recovered).toBe(1);
    });

    it("a plain quit with an update ready records it (Squirrel installs at any quit)", async () => {
      const h = harness();
      await ready(h);
      h.ctl.quitting();
      expect(h.pending).toMatchObject({ from: "0.1.0", to: "0.2.0" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a plain quit with nothing ready records nothing", () => {
      const h = harness();
      h.ctl.quitting();
      expect(h.pending).toBeNull();
    });
  });

  describe("health after an install, once the backend is ready", () => {
    const record = { from: "0.1.0", to: "0.2.0", txId: "tx1", at: 1 };

    it("the new version running: applied (logged), said once", () => {
      const h = harness({ version: "0.2.0", pending: record });
      h.ctl.backendReady();
      expect(h.ctl.view.justUpdated).toBe("0.2.0");
      expect(h.logs).toContainEqual(["update.applied", { fromVersion: "0.1.0", toVersion: "0.2.0" }]);
      expect(h.pending).toBeNull();
      h.ctl.seen();
      h.ctl.backendReady(); // a restarted backend is not a second install
      expect(h.ctl.view.justUpdated).toBeNull();
    });

    it("the old version still running: not applied, captured as unexpected, retry offered", () => {
      const h = harness({ version: "0.1.0", pending: record });
      h.ctl.backendReady();
      expect(h.ctl.view).toMatchObject({ status: "error", error: { stage: "install", kind: "not-applied", canRetry: true } });
      expect(h.captures).toEqual([["update.not_applied", { fromVersion: "0.1.0", toVersion: "0.2.0" }, false]]);
      expect(h.pending).toBeNull();
    });

    it("another version (installed by hand): nothing said, record dropped", () => {
      const h = harness({ version: "0.3.0", pending: record });
      h.ctl.backendReady();
      expect(h.published).toEqual([]);
      expect(h.pending).toBeNull();
    });
  });

  it("an unsupported copy (the DMG): never loads the engine; a manual check just says why", async () => {
    const h = harness({ unsupported: "dmg" });
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY + CHECK_EVERY_MS);
    expect(h.ctl.view).toMatchObject({ status: "unsupported", unsupported: "dmg" });
    expect((await h.ctl.check("manual")).status).toBe("unsupported");
    expect(h.loads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the backend's first policy (local mode off) arriving after launch still probes before the first check", async () => {
    const h = harness({ localMode: true, unsupported: "dmg" });
    h.ctl.start();
    h.ctl.setLocalMode(false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.ctl.view.status).toBe("unsupported");
    expect(h.loads).toBe(0);
  });

  it("switching channel cancels the other channel's download, checks the new one, and is remembered", async () => {
    const h = harness();
    h.engine.next = release("0.2.0");
    h.ctl.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(h.ctl.view.status).toBe("downloading");
    h.engine.next = release("0.3.0-nightly.1");
    h.ctl.setPrefs({ mode: "auto", channel: "nightly" });
    await flush();
    await flush();
    expect(h.engine.cancelled).toBe(1);
    expect(h.prefs.channel).toBe("nightly");
    expect(h.ctl.view).toMatchObject({ channel: "nightly", status: "downloading", available: { version: "0.3.0-nightly.1" } });
  });
});
