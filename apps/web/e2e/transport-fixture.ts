import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication } from "@playwright/test";
import type { RpcRequest, RpcResponse } from "@terno/core/rpc";
import { rows, test as base } from "./fixtures";
import { E2E_NOW } from "./constants";

interface RecordEntry {
  epoch: number;
  kind: "request-port" | "delivered" | "port-closed" | "ws-closed" | "request" | "response" | "blocked";
  frame?: RpcRequest | RpcResponse;
}
interface TransportControls {
  blockSave(): Promise<void>;
  disconnect(): Promise<void>;
  replace(): Promise<void>;
}
declare global {
  interface Window {
    __transport: TransportControls & { records: RecordEntry[] };
    __transportHost: TransportControls;
  }
}

// Electron's native MessagePort close is an extension absent in ordinary Chromium.
export const test = base.extend({
  page: async ({ server }, use, info) => {
    const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
    const executablePath = requireDesktop("electron") as string;
    const profile = mkdtempSync(join(tmpdir(), "terno-transport-profile-"));
    const recordPath = info.outputPath("host-process.json");
    let pid: number | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, TRANSPORT_PROFILE: profile, TRANSPORT_BACKEND: server.url };
    delete env.ELECTRON_RUN_AS_NODE;
    writeFileSync(recordPath, JSON.stringify({ profile }));
    let electron: ElectronApplication | undefined;
    try {
      electron = await _electron.launch({
        executablePath,
        args: [fileURLToPath(new URL("./transport-host.cjs", import.meta.url))],
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        locale: "en-US", timezoneId: "America/Costa_Rica",
      });
      pid = electron.process().pid;
      writeFileSync(recordPath, JSON.stringify({ profile, pid }));
      const page = await electron.firstWindow();
      await page.addInitScript(() => {
        let epoch = 0;
        const records: RecordEntry[] = [];
        const note = (entry: RecordEntry) => {
          if (records.length >= 500) throw new Error("transport evidence overflow");
          records.push(entry);
        };
        window.addEventListener("message", (event) => {
          if (event.source !== window) return;
          if (event.data?.type === "transport:epoch") epoch = event.data.epoch;
          if (event.data?.type === "transport:record") note(event.data.record);
          if (event.data === "terno:request-port") note({ epoch, kind: "request-port" });
          if (event.data === "terno:backend-port" && event.ports[0]) {
            const current = epoch;
            note({ epoch: current, kind: "delivered" });
            event.ports[0].addEventListener("close", () => note({ epoch: current, kind: "port-closed" }));
          }
        });
        window.__transport = {
          records,
          blockSave: () => window.__transportHost.blockSave(),
          disconnect: () => window.__transportHost.disconnect(),
          replace: () => window.__transportHost.replace(),
        };
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await use(page);
    } finally {
      if (electron) await electron.close();
      rmSync(profile, { recursive: true, force: true });
      writeFileSync(recordPath, JSON.stringify({ profile, pid, launchReturned: Boolean(electron), closed: electron ? true : undefined, profileRemoved: true }));
    }
  },
  app: async ({ page, server, fixedClock, backendOptions, design, layout, baseURL }, use) => {
    if (fixedClock) await page.clock.setFixedTime(new Date(E2E_NOW));
    const ctx = { clientId: "setup", origin: "dev" as const };
    if (design) await server.backend.server.invoke("settings.update", { design }, ctx);
    if (layout) await server.backend.server.invoke("settings.update", { layout }, ctx);
    // Electron's persistent context does not inherit the runner's baseURL option.
    await page.goto(new URL(`/?backend=${encodeURIComponent(server.url)}&token=e2e`, baseURL).href);
    await page.locator("[data-ready]").waitFor();
    if (!backendOptions.empty) await rows(page).first().waitFor();
    await use(page);
  },
});
