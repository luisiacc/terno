/**
 * Storage left by the web build when it was called Única moves to its Terno
 * names in a real Chromium (OPFS sahpool, IndexedDB, the WebCrypto key store,
 * the caches beside the mailbox, localStorage), and a tab of that older build
 * still open keeps the mailbox until it hands it over.
 *
 * The legacy layout is made from a current one: a mailbox created under the
 * legacy default name (?mailbox=unica) whose storage is then renamed to what
 * Única used (".unica-sahpool", "unica-files", "unica-keys", "unica-unica",
 * "unica:*" keys). Opening the default mailbox ("terno") must find it all.
 */
import { expect, test, type Page } from "@playwright/test";

const rows = (page: Page) => page.getByTestId("thread-row");
const KEY = "sk-legacy-web-0000-4242";

type Snapshot = { ids: number[]; unread: number };
const call = (page: Page, method: string, params: unknown) => page.evaluate(([m, p]) => (window.__ternoWeb!.client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call(m, p), [method, params] as const);
async function snapshot(page: Page): Promise<Snapshot> {
  const list = (await call(page, "threads.list", { view: "all", limit: 200 })) as { items: { id: number }[] };
  const counts = (await call(page, "counts.get", {})) as { inboxUnread: number };
  return { ids: list.items.map((t) => t.id), unread: counts.inboxUnread };
}

const hasKey = async (page: Page) => ((await call(page, "app.bootstrap", {})) as { settings: { ai: { hasKey: boolean; keyHint: string | null } } }).settings.ai;

/** Creates the mailbox under the legacy default name, with an API key sealed by the install's key store. */
async function seedLegacyMailbox(page: Page, storage: string | null): Promise<Snapshot> {
  await page.goto(`/?demo=300&mailbox=unica${storage ? `&storage=${storage}` : ""}`);
  await rows(page).first().waitFor({ timeout: 60_000 });
  await call(page, "settings.update", { ai: { provider: "compatible", preset: "custom", baseURL: "http://127.0.0.1:9/v1", model: "m-1" } });
  await call(page, "ai.setKey", { provider: "compatible", preset: "custom", value: KEY });
  expect(await hasKey(page)).toMatchObject({ hasKey: true, keyHint: "4242" });
  return snapshot(page);
}

/** Seals a probe with the CryptoKey kept in a key store database (as the worker's cipher does), or opens one. */
const sealWithKeyStore = (page: Page, db: string, sealed?: number[]) =>
  page.evaluate(
    async ([name, input]) => {
      const key = await new Promise<CryptoKey>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const r = open.result.transaction("keys").objectStore("keys").get("secrets-v1");
          r.onsuccess = () => (open.result.close(), resolve(r.result as CryptoKey));
          r.onerror = () => reject(r.error);
        };
        open.onerror = () => reject(open.error);
      });
      if (input) return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(input.slice(0, 12)) }, key, new Uint8Array(input.slice(12))));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return [...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("probe ñ")))];
    },
    [db, sealed ?? null] as const,
  );

/** Renames this origin's storage to Única's names, on a page of the origin that doesn't start the app. */
async function renameToLegacy(page: Page): Promise<void> {
  await page.goto("/theme.js");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const retry = async <T,>(fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (error) {
          // the closed tab's worker may still be letting its access handles go
          if (i > 50) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
    const copyDir = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle) => {
      for await (const [name, handle] of from as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === "directory") await copyDir(handle as FileSystemDirectoryHandle, await to.getDirectoryHandle(name, { create: true }));
        else {
          const file = await retry(() => (handle as FileSystemFileHandle).getFile());
          const w = await (await to.getFileHandle(name, { create: true })).createWritable();
          await w.write(await file.arrayBuffer());
          await w.close();
        }
      }
    };
    for (const [from, to] of [
      [".terno-sahpool", ".unica-sahpool"],
      ["terno-files", "unica-files"],
    ]) {
      const dir = await root.getDirectoryHandle(from!).catch(() => null);
      if (!dir) continue;
      await copyDir(dir, await root.getDirectoryHandle(to!, { create: true }));
      await retry(() => root.removeEntry(from!, { recursive: true }));
    }

    const req = <T,>(r: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    for (const [from, to] of [
      ["terno-keys", "unica-keys"],
      ["terno-unica", "unica-unica"],
    ]) {
      if (!(await indexedDB.databases()).some((d) => d.name === from)) continue;
      const src = await req(indexedDB.open(from!));
      const open = indexedDB.open(to!, src.version);
      open.onupgradeneeded = () => {
        for (const name of src.objectStoreNames) open.result.createObjectStore(name);
      };
      const dst = await req(open);
      for (const name of src.objectStoreNames) {
        const s = src.transaction(name).objectStore(name);
        const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
        const tx = dst.transaction(name, "readwrite");
        keys.forEach((k, i) => tx.objectStore(name).put(values[i], k));
        await new Promise((r) => (tx.oncomplete = r));
      }
      src.close();
      dst.close();
      await req(indexedDB.deleteDatabase(from!));
    }

    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("terno:")) continue;
      localStorage.setItem(key === "terno:storage:unica" ? "unica:storage:unica" : `unica:${key.slice(6)}`, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
  });
}

async function leftovers(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const opfs: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) opfs.push(name);
    return {
      opfs: opfs.sort(),
      idb: (await indexedDB.databases()).map((d) => d.name).sort(),
      keys: Object.keys(localStorage).filter((k) => k.startsWith("unica:") || k.startsWith("terno:storage:")),
      pin: localStorage.getItem("terno:storage:terno"),
    };
  });
}

for (const storage of ["opfs-sqlite", "idb"] as const) {
  test(`Única's mailbox on ${storage}, its key store, caches and settings move to Terno's names and open as the default mailbox`, async ({ context, page }) => {
    const before = await seedLegacyMailbox(page, storage === "idb" ? "idb" : null);
    await page.close();
    const fixture = await context.newPage();
    await fixture.goto("/theme.js");
    const probe = (await sealWithKeyStore(fixture, "terno-keys")) as number[];
    await renameToLegacy(fixture);
    const legacy = await leftovers(fixture);
    expect(legacy.idb).toContain("unica-keys");
    if (storage === "idb") expect(legacy.idb).toContain("unica-unica");
    else expect(legacy.opfs).toEqual(expect.arrayContaining([".unica-sahpool", "unica-files"]));
    await fixture.close();

    const app = await context.newPage();
    await app.goto("/?demo=0");
    await rows(app).first().waitFor({ timeout: 60_000 });
    expect(await app.evaluate(() => window.__ternoWeb!.storage)).toBe(storage);
    expect(await snapshot(app)).toEqual(before);
    // the key store moved with its very CryptoKey (non-extractable, so never as bytes): what it sealed still opens
    expect(await sealWithKeyStore(app, "terno-keys", probe)).toBe("probe ñ");
    expect(await hasKey(app)).toMatchObject({ hasKey: true, keyHint: "4242" });
    // nothing under Única's names is left
    const after = await leftovers(app);
    expect(after.opfs.filter((n) => n.includes("unica"))).toEqual([]);
    expect(after.idb.filter((n) => n?.startsWith("unica-"))).toEqual([]);
    expect(after.idb).toEqual(expect.arrayContaining(["terno-keys", ...(storage === "idb" ? ["terno-terno"] : [])]));
    expect(after.keys).toEqual(["terno:storage:terno"]);
    expect(after.pin).toBe(storage);
  });
}

test("a tab of the older build (still called Única) keeps the mailbox until it hands it over, and learns it should reload", async ({ context, page }) => {
  // stands in for the old build: it leads under the legacy lock and answers on the legacy channel as that build did
  await page.goto("/theme.js");
  await page.evaluate(
    () =>
      new Promise<void>((held) => {
        const w = window as unknown as { msgs: unknown[] };
        w.msgs = [];
        const channel = new BroadcastChannel("unica-tabs");
        let release: () => void = () => {};
        void navigator.locks.request("unica-backend", () => {
          held();
          return new Promise<void>((r) => (release = r));
        });
        channel.onmessage = (e: MessageEvent<{ type: string; from?: string }>) => {
          w.msgs.push(e.data);
          if (e.data.type === "takeover") {
            release();
            channel.postMessage({ type: "handoff", to: e.data.from });
          }
        };
      }),
  );
  const tab = await context.newPage();
  await tab.goto("/?demo=300");
  await expect(tab.getByTestId("web-elsewhere")).toBeVisible();
  await expect(rows(tab)).toHaveCount(0);
  await tab.getByTestId("web-use-here").click();
  await rows(tab).first().waitFor({ timeout: 60_000 });
  const msgs = (await page.evaluate(() => (window as unknown as { msgs: { type: string; build?: string }[] }).msgs)) as { type: string; build?: string }[];
  expect(msgs.map((m) => m.type)).toEqual(expect.arrayContaining(["takeover", "leader"]));
  expect(msgs.find((m) => m.type === "leader")!.build).toBeTruthy();
});
