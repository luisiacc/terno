/**
 * The renderer's dev-server port for scripts/dev.mjs. Plain Node and erasable
 * TypeScript only: dev.mjs imports it with type stripping.
 *
 * The default is uncommon (5173 is every Vite project's), and when it's taken
 * the next free one is used. A port asked for with TERNO_VITE_PORT is kept as
 * is: if it's busy, Vite says so.
 */
import { createServer } from "node:net";

export const DEFAULT_DEV_PORT = 5847;

/** Free on both loopbacks: "localhost" is ::1 first on macOS, 127.0.0.1 elsewhere. */
async function isFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")); // no IPv6 here: nothing can hold it
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

export async function devPort(env: { TERNO_VITE_PORT?: string }, { start = DEFAULT_DEV_PORT, tries = 20 } = {}): Promise<{ port: number; fellBack: boolean }> {
  if (env.TERNO_VITE_PORT) return { port: Number(env.TERNO_VITE_PORT), fellBack: false };
  for (let port = start; port < start + tries; port++) {
    if (await isFree(port)) return { port, fellBack: port !== start };
  }
  throw new Error(`No free port in ${start}–${start + tries - 1}; set TERNO_VITE_PORT to choose one.`);
}
