// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));

it("keeps a focus move started while completing the previous move", async () => {
  const { focusSoon } = await import("./inline-draft");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0, started = false;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++next, cb); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div");
  host.innerHTML = '<button data-first></button><button data-old></button><button data-new></button>';
  document.body.append(host);
  try {
    focusSoon("[data-first]", host, 1, () => { started = true; focusSoon("[data-new]", host); const immediate = [...frames.values()]; frames.clear(); immediate.forEach((fn) => fn(0)); });
    focusSoon("[data-old]", host);
    expect(started).toBe(true);
    const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(0));
    expect(document.activeElement).toBe(host.querySelector("[data-new]"));
  } finally { host.remove(); raf.mockRestore(); cancel.mockRestore(); }
});
