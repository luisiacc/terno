import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEV_PORT, devPort } from "./dev-port";

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

  it("says how to choose one when the whole range is taken", async () => {
    const start = await hold("127.0.0.1");
    await expect(devPort({}, { start, tries: 1 })).rejects.toThrow(/TERNO_VITE_PORT/);
  });
});
