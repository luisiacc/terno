import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_PORT, devPort, viteLocalUrl } from "./dev-port";

const held: Server[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** an OS-chosen free port, then a server holding it on `host` */
async function hold(host: string, port = 0): Promise<number> {
  const server = createServer();
  held.push(server);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen({ port, host }, resolve));
  return (server.address() as { port: number }).port;
}

describe("dev server port", () => {
  it("loads in plain Node (scripts/dev.mjs imports it with type stripping only)", () => {
    const file = join(import.meta.dirname, "dev-port.ts");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(file)}); console.log(typeof m.devPort, m.DEFAULT_DEV_PORT)`], { encoding: "utf8" });
    expect(out.trim()).toBe(`function ${DEFAULT_DEV_PORT}`);
  });

  it("isn't Vite's 5173", () => expect(DEFAULT_DEV_PORT).not.toBe(5173));

  it("takes the start port when it's free", async () => {
    const start = await hold("127.0.0.1");
    await new Promise((r) => held.pop()!.close(r));
    expect(await devPort({}, { start })).toEqual({ port: start, fellBack: false });
  });

  it("moves on when the start port is taken on IPv4", async () => {
    const start = await hold("127.0.0.1");
    const got = await devPort({}, { start });
    expect(got.fellBack).toBe(true);
    expect(got.port).toBeGreaterThan(start);
  });

  it("moves on when the start port is taken only on ::1 (Vite's localhost on macOS)", async () => {
    let start: number;
    try {
      start = await hold("::1");
    } catch {
      return; // no IPv6 loopback on this machine
    }
    const got = await devPort({}, { start });
    expect(got).toMatchObject({ fellBack: true });
    expect(got.port).not.toBe(start);
  });

  it("keeps a port asked for with TERNO_VITE_PORT, busy or not", async () => {
    const busy = await hold("127.0.0.1");
    expect(await devPort({ TERNO_VITE_PORT: String(busy) })).toEqual({ port: busy, fellBack: false });
  });

  it("reads Vite's Local URL, colored or not, and nothing before it", () => {
    expect(viteLocalUrl("  VITE v8.3.5  ready in 312 ms\n")).toBeNull();
    expect(viteLocalUrl("  ➜  Local:   http://localhost:5848/\n  ➜  Network: use --host to expose\n")).toBe("http://localhost:5848");
    expect(viteLocalUrl("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5849\x1b[22m/\x1b[39m\n")).toBe("http://localhost:5849");
    // a chunk cut mid-URL isn't a URL yet
    expect(viteLocalUrl("  ➜  Local:   http://localhost:58")).toBeNull();
  });

  // Codex: the port is free when chosen, then another checkout takes it before Vite binds. Vite
  // (no --strictPort) moves on, and the URL dev.mjs follows is the one Vite reports.
  it("a port taken after it was chosen: Vite moves on and reports where it went", async () => {
    const root = mkdtempSync(join(tmpdir(), "terno-devport-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");
    const { port } = await devPort({}, { start: 40000 + Math.floor(Math.random() * 9000) });
    await hold("::1", port).catch(() => hold("127.0.0.1", port)); // the race: someone binds it first
    const viteBin = join(dirname(createRequire(join(import.meta.dirname, "../../web/package.json")).resolve("vite/package.json")), "bin", "vite.js");
    const vite = spawn(process.execPath, [viteBin, root, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let seen = "";
        vite.stdout.on("data", (c) => {
          seen += c;
          const found = viteLocalUrl(seen);
          if (found) resolve(found);
        });
        vite.once("exit", (code) => reject(new Error(`vite exited ${code}`)));
      });
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(Number(url.split(":").pop())).not.toBe(port);
      expect((await fetch(url)).ok).toBe(true);
    } finally {
      vite.kill("SIGTERM");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("says how to choose one when the whole range is taken", async () => {
    const start = await hold("127.0.0.1");
    await expect(devPort({}, { start, tries: 1 })).rejects.toThrow(/TERNO_VITE_PORT/);
  });
});
