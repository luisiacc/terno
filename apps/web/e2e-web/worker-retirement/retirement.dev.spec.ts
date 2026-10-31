import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test, type Page, type Worker as BrowserWorker } from "@playwright/test";

declare global { interface Window { closeAcknowledgements: number; handleProbe: { worker: Worker; url: string } } }

function trackProbe(task: Promise<unknown>, tasks: Promise<unknown>[], errors: unknown[]) {
  tasks.push(task.catch((error) => { errors.push(error); }));
}

interface Stream { source: string; closed: boolean; socketClosed: boolean; response: ServerResponse }
async function closeStreams(server: Server, streams: Stream[], probes: Promise<unknown>[]) {
  const closeLate = (_request: IncomingMessage, response: ServerResponse) => response.destroy();
  server.on("request", closeLate);
  try {
    for (const stream of streams) stream.response.destroy();
    await Promise.all(probes);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally { server.off("request", closeLate); }
}

interface Witness { file: string; source: string; dead: boolean; closed: boolean; socketClosed: boolean; starts: string[] }
function retired(w: Witness, source: string, file: string) {
  expect(w.file).toBe(file);
  expect(w.source).toBe(source);
  expect(w.dead).toBe(true);
  expect(w.closed).toBe(true);
  expect(w.socketClosed).toBe(true);
  expect(w.starts.filter((s) => s === source)).toHaveLength(1);
}

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage), { timeout: 20_000 }).toBe("opfs-sqlite");
  return page.workers().find((w) => w.url().includes("backend.worker"))!;
}

async function handle(worker: BrowserWorker, file: string) {
  return worker.evaluate(async (file) => {
    const root = await navigator.storage.getDirectory();
    const f = await root.getFileHandle(file, { create: true });
    // This test-only type describes Chromium's native worker-only OPFS API.
    const access = f as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ close(): void }> };
    try { const h = await access.createSyncAccessHandle(); h.close(); return true; }
    catch (error) { if ((error as DOMException).name === "NoModificationAllowedError") return false; throw error; }
  }, file);
}

for (const mode of ["graceful", "delayed", "stuck", "late", "error", "reload"] as const) {
  test(`physical worker retirement: ${mode}`, async ({ page, context, baseURL }, testInfo) => {
    const successorProbes: Promise<unknown>[] = [], probeErrors: unknown[] = [];
    const watchers: { page: Page; listener: (worker: BrowserWorker) => void }[] = [];
    let follower: Page | undefined;
    let completed = false;
    const blockedDemoImages: string[] = [];
    const successorStarts: { source: string; oldClosed: boolean; oldSocketClosed: boolean }[] = [];
    const streams: Stream[] = [], unexpected: string[] = [], events: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture");
      if (req.method !== "GET" || url.pathname !== "/stream" || !url.searchParams.get("source")) { unexpected.push(`endpoint ${req.method} ${req.url}`); res.writeHead(404).end(); return; }
      const source = url.searchParams.get("source")!;
      const stream: Stream = { source, closed: false, socketClosed: false, response: res };
      if (source.endsWith("-new")) successorStarts.push({ source, oldClosed: streams[0]?.closed === true, oldSocketClosed: streams[0]?.socketClosed === true });
      streams.push(stream); events.push(`request:${source}`);
      res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/octet-stream", "connection": "close" });
      res.write("native-body-open");
      res.on("close", () => { stream.closed = true; events.push(`response-close:${source}`); });
      req.socket.on("close", () => { stream.socketClosed = true; events.push(`socket-close:${source}`); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(62021, "127.0.0.1", resolve); });
    const endpoint = "http://127.0.0.1:62021/stream";
    await page.addInitScript(() => {
      Object.assign(window, { closeAcknowledgements: 0 });
      addEventListener("w05-worker-closed", () => { window.closeAcknowledgements++; });
    });
    try {
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === baseURL || url.origin === "http://127.0.0.1:62021" && url.pathname === "/stream") return route.continue();
        if (route.request().method() === "GET" && url.href === "https://updates.figma.com/pixel.gif") {
          blockedDemoImages.push(url.href);
          return route.abort();
        }
        unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
      });
      await page.goto(`/?demo=8&accounts=2&mailbox=w05-${mode}`);
      const old = await ready(page);
      const baseline = await page.evaluate(async () => {
        const c = window.__ternoWeb!.client;
        const accounts = (await c.call("app.bootstrap", {})).accounts;
        const rows = [];
        for (const account of accounts) {
          const ref = await c.call("attachments.create", { accountId: account.id, filename: "retained.bin", mime: "application/octet-stream", size: 3 });
          await c.call("attachments.append", { accountId: account.id, assetId: ref.assetId, index: 0, dataBase64: "AP+A" });
          await c.call("attachments.seal", { accountId: account.id, assetId: ref.assetId });
          rows.push(await c.call("drafts.save", { accountId: account.id, generation: `saved-${account.id}`, subject: `Exact ${account.id}`, bodyText: "Durable authored body", attachments: [ref] }));
        }
        return { accounts, rows };
      });
      expect(baseline.accounts).toHaveLength(2);
      expect(baseline.rows.every(Boolean)).toBe(true);
      const source = `${mode}-old-${testInfo.testId}`, file = `w05-${mode}.lock`;
      const state = await old.evaluate(async ({ endpoint, source, file, mode }) => {
        const root = await navigator.storage.getDirectory();
        const f = await root.getFileHandle(file, { create: true });
        const h = await (f as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ close(): void }> }).createSyncAccessHandle();
        const response = await fetch(`${endpoint}?source=${encodeURIComponent(source)}`);
        const reader = response.body!.getReader();
        const first = await reader.read();
        const probe = { h, reader, source, closeRequested: false, closedAck: false, bodyDone: false };
        Object.assign(globalThis, { retirementProbe: probe });
        void reader.read().then(() => { probe.bodyDone = true; }, () => { probe.bodyDone = true; });
        const original = self.onmessage;
        self.onmessage = function (event) {
          if (event.data?.type === "close") {
            probe.closeRequested = true;
            if (mode === "stuck") return;
            if (mode === "late" || mode === "delayed") { setTimeout(() => original?.call(self, event), mode === "late" ? 12_000 : 500); return; }
          }
          original?.call(self, event);
        };
        return { source, first: new TextDecoder().decode(first.value), done: first.done };
      }, { endpoint, source, file, mode });
      expect(state).toEqual({ source, first: "native-body-open", done: false });
      expect(streams.map((s) => s.source)).toEqual([source]);
      let dead = false;
      old.on("close", () => { dead = true; events.push(`worker-close:${source}`); });
      const waiting = follower = await context.newPage();
      await follower.goto(`/?demo=0&mailbox=w05-${mode}`);
      await expect(follower.getByTestId("web-use-here")).toBeVisible();
      expect(follower.workers()).toHaveLength(0);
      // A separate actual worker tests the same OPFS handle while the owner is alive.
      await follower.evaluate(() => {
        const blob = new Blob(["onmessage=async e=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle(e.data);const h=await f.createSyncAccessHandle();h.close();postMessage(true)}catch(e){postMessage(e.name)}}"], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        Object.assign(window, { handleProbe: { worker, url } });
      });
      const probeHandle = () => waiting.evaluate((file) => new Promise<boolean | string>((resolve) => {
        const probe = window.handleProbe;
        probe.worker.onmessage = (event) => resolve(event.data);
        probe.worker.postMessage(file);
      }), file);
      expect(await probeHandle()).toBe("NoModificationAllowedError");
      expect(dead).toBe(false); expect(streams[0]!.closed).toBe(false);
      const sibling = await context.newPage();
      await sibling.goto(`/?demo=0&mailbox=w05-${mode}`);
      await expect(sibling.getByTestId("web-use-here")).toBeVisible();
      expect(sibling.workers()).toHaveLength(0);
      for (const candidate of [page, follower, sibling]) {
        const listener = (worker: BrowserWorker) => {
        if (!worker.url().includes("backend.worker")) return;
        trackProbe(worker.evaluate(async ({ endpoint, source }) => {
          const response = await fetch(`${endpoint}?source=${encodeURIComponent(source)}`);
          const reader = response.body!.getReader();
          await reader.read();
          Object.assign(globalThis, { successorReader: reader, successorSource: source });
        }, { endpoint, source: `${mode}-new` }), successorProbes, probeErrors);
        };
        watchers.push({ page: candidate, listener });
        candidate.on("worker", listener);
      }
      if (mode === "reload") await page.reload();
      else if (mode === "error") await old.evaluate(() => { setTimeout(() => { throw new Error("synthetic worker retirement"); }, 0); });
      else {
        await follower.getByTestId("web-use-here").click();
        if (mode === "graceful") await page.waitForTimeout(1500);
        if (mode === "stuck" || mode === "late") await expect.poll(() => old.evaluate(() => (globalThis as typeof globalThis & { retirementProbe: { closeRequested: boolean } }).retirementProbe.closeRequested)).toBe(true);
        if (mode === "stuck" || mode === "late") {
          await page.waitForTimeout(9000);
          expect(dead).toBe(false); expect(streams[0]!.closed).toBe(false);
          expect(await old.evaluate(() => (globalThis as typeof globalThis & { retirementProbe: { bodyDone: boolean } }).retirementProbe.bodyDone)).toBe(false);
          expect(follower.workers().filter((w) => w.url().includes("backend.worker"))).toHaveLength(0);
          expect(sibling.workers()).toHaveLength(0);
          expect(await probeHandle()).toBe("NoModificationAllowedError");
        }
      }
      await expect.poll(() => dead, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => streams[0]!.closed && streams[0]!.socketClosed).toBe(true);
      expect(await probeHandle()).toBe(true);
      if (mode !== "reload") expect(await page.evaluate(() => window.closeAcknowledgements)).toBe(mode === "graceful" || mode === "delayed" ? 1 : 0);
      // Let the public leadership protocol select a successor; do not gate its startup on our observations.
      const candidates = mode === "reload" ? [page, follower, sibling] : [follower, sibling];
      await expect.poll(async () => (await Promise.all(candidates.map((p) => p.evaluate(() => window.__ternoWeb?.storage)))).filter((s) => s === "opfs-sqlite").length, { timeout: 20_000 }).toBe(1);
      const successor = (await Promise.all(candidates.map(async (p) => ({ p, storage: await p.evaluate(() => window.__ternoWeb?.storage) })))) .find((r) => r.storage === "opfs-sqlite")!.p;
      const replacement = successor.workers().find((w) => w.url().includes("backend.worker"))!;
      expect(replacement).not.toBe(old);
      expect(await handle(replacement, file)).toBe(true);
      const after = await successor.evaluate(async () => {
        const c = window.__ternoWeb!.client;
        const boot = await c.call("app.bootstrap", {});
        const rows = await c.call("drafts.list", {});
        const bytes = await Promise.all(rows.map((row) => c.call("attachments.read", { accountId: row.accountId, assetId: row.attachments![0]!.assetId, index: 0 })));
        return { accounts: boot.accounts, rows, bytes };
      });
      expect(after.accounts.map((a) => a.id).sort()).toEqual(baseline.accounts.map((a) => a.id).sort());
      expect(after.rows).toHaveLength(2);
      for (const row of baseline.rows) expect(after.rows).toContainEqual(row);
      expect(after.bytes).toEqual([{ dataBase64: "AP+A" }, { dataBase64: "AP+A" }]);
      await Promise.all(successorProbes);
      expect(probeErrors).toEqual([]);
      await expect.poll(() => successorStarts.length).toBe(1);
      expect(successorStarts).toEqual([{ source: `${mode}-new`, oldClosed: true, oldSocketClosed: true }]);
      expect(streams.map((s) => s.source)).toEqual([source, `${mode}-new`]);
      const witness: Witness = { file, source: streams[0]!.source, dead, closed: streams[0]!.closed, socketClosed: streams[0]!.socketClosed, starts: streams.map((s) => s.source) };
      retired(witness, source, file);
      for (const corrupt of [{ ...witness, file: "wrong" }, { ...witness, dead: false }, { ...witness, closed: false }, { ...witness, source: "wrong" }, { ...witness, starts: [source, source] }]) expect(() => retired(corrupt, source, file)).toThrow();
      expect(() => expect(after.rows).toContainEqual({ ...baseline.rows[0], bodyText: "wrong" })).toThrow();
      expect(unexpected).toEqual([]);
      await testInfo.attach("physical-ledger", { body: JSON.stringify({ source, replacement: replacement.url(), events, witness, successorStarts, blockedDemoImages }), contentType: "application/json" });
      completed = true;
    } finally {
      for (const watcher of watchers) watcher.page.off("worker", watcher.listener);
      if (follower && !follower.isClosed()) await follower.evaluate(() => {
        const p = window.handleProbe;
        if (p) { p.worker.terminate(); URL.revokeObjectURL(p.url); }
      }).catch((error) => { probeErrors.push(error); });
      // Only owned fixture connections; terminal assertions above precede all cleanup.
      await closeStreams(server, streams, successorProbes).catch((error) => { probeErrors.push(error); });
      if (completed) expect(probeErrors).toEqual([]);
    }
  });
}


test("probe rejection and early assertion preserve the primary failure and join", async ({ page, context, baseURL }) => {
  const unexpected: string[] = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === baseURL && new URL(route.request().url()).pathname === "/probe-host") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Owned probe</title>" });
    unexpected.push(route.request().url()); return route.abort();
  });
  await page.goto("/probe-host");
  const started = page.waitForEvent("worker");
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(["onmessage=()=>{}"], { type: "text/javascript" }));
    window.handleProbe = { worker: new Worker(url), url };
  });
  const worker = await started;
  expect(await worker.evaluate(() => true)).toBe(true);
  const tasks: Promise<unknown>[] = [], errors: unknown[] = [];
  let primary: unknown, expectedPrimary: unknown;
  try {
    try {
      trackProbe(worker.evaluate(() => { throw new Error("native worker probe refusal"); }), tasks, errors);
      try { expect("early observation").toBe("expected observation"); }
      catch (error) { expectedPrimary = error; throw error; }
    } finally {
      try { await Promise.all(tasks); }
      finally { await page.evaluate(() => { window.handleProbe.worker.terminate(); URL.revokeObjectURL(window.handleProbe.url); }); }
    }
  } catch (error) { primary = error; }
  expect(expectedPrimary).toBeInstanceOf(Error);
  expect(primary).toBe(expectedPrimary);
  expect(errors).toHaveLength(1);
  expect(tasks).toHaveLength(1);
  expect(unexpected).toEqual([]);
});


test("teardown owns a successor request arriving after its first response sweep", async () => {
  const streams: Stream[] = [];
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer((_req, response) => {
    streams.push({ source: "late", closed: false, socketClosed: false, response });
    response.writeHead(200, { "connection": "close" });
    response.write("held");
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned fixture address");
  let request: Promise<unknown> | undefined;
  const probe = gate.then(() => {
    request = fetch(`http://127.0.0.1:${address.port}/stream`).then(async (response) => { await response.body!.getReader().read(); }).catch(() => {});
    return seen;
  });
  const closing = closeStreams(server, streams, [probe]);
  release();
  try {
    await probe;
    expect(streams).toHaveLength(1);
    expect(streams[0]!.response.destroyed).toBe(true);
  } finally {
    // Failure rescue is restricted to this fixture's own native connections.
    server.closeAllConnections();
    await Promise.all([closing, request]);
  }
});
