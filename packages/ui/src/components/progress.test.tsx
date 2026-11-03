// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Progress } from "./progress";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

describe("Progress (plan 125)", () => {
  it("is a progressbar named by its label, its value and its words; the shown value is the bar's to say", async () => {
    const host = await render(<Progress value={22.4} label="Personal" valueLabel="~4,321 left" aria-valuetext="About 4,321 messages left" />);
    const bar = host.querySelector("[role=progressbar]")!;
    expect(document.getElementById(bar.getAttribute("aria-labelledby")!)!.textContent).toBe("Personal");
    expect([bar.getAttribute("aria-valuemin"), bar.getAttribute("aria-valuemax"), bar.getAttribute("aria-valuenow")]).toEqual(["0", "100", "22"]);
    expect(bar.getAttribute("aria-valuetext")).toBe("About 4,321 messages left");
    expect(host.querySelector("[aria-hidden]")!.textContent).toBe("~4,321 left");
    expect(host.querySelector<HTMLElement>("[data-slot=progress-fill]")!.style.transform).toBe("translateX(-77.6%)");
  });

  it("an amount not known yet has no value, and draws a third; a bar just begun still shows its end", async () => {
    let host = await render(<Progress value={null} aria-label="Work" />);
    const bar = host.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-label")).toBe("Work");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(host.querySelector<HTMLElement>("[data-slot=progress-fill]")!.style.transform).toBe("translateX(-70%)");
    cleanup?.();
    host = await render(<Progress value={0} aria-label="Work" />);
    expect(host.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("0");
    expect(host.querySelector<HTMLElement>("[data-slot=progress-fill]")!.style.transform).toBe("translateX(-96%)");
  });
});
