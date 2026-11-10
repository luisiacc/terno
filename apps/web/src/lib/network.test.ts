// @vitest-environment jsdom
/** Plan 176 on the web: the page's focus goes to the backend as it changes, and again to a backend (re)attached. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls: { method: string; params: Record<string, unknown> }[] = [];
const attached = new Set<() => void>();
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => void calls.push({ method, params })),
    onAttach: (l: () => void) => (attached.add(l), () => attached.delete(l)),
  },
}));

let focused = true;
let off = () => {};
beforeEach(() => {
  calls.length = 0;
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  off();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const told = () => calls.filter((c) => c.method === "sync.focus").map((c) => c.params.focused);

async function install(target: string) {
  vi.stubEnv("VITE_TARGET", target);
  vi.resetModules();
  const { installNetworkEvents } = await import("./network");
  off = installNetworkEvents();
}

it("tells the page's focus once per change, from the start, and again on a (re)attach", async () => {
  await install("web");
  expect(told()).toEqual([true]);
  window.dispatchEvent(new Event("focus"));
  expect(told()).toEqual([true]);
  focused = false;
  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(told()).toEqual([true, false]);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(told()).toEqual([true, false, true]);
  // a backend restarted: it hears where focus is, though nothing changed here
  for (const l of attached) l();
  expect(told()).toEqual([true, false, true, true]);
  off();
  expect(attached.size).toBe(0);
});

it("desktop's renderer leaves it to main (the OS's focus, which a mail frame doesn't hide)", async () => {
  await install("desktop");
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("blur"));
  expect(told()).toEqual([]);
});
