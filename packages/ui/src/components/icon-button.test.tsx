// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Archive } from "../icons";
import { IconButton } from "./icon-button";
import { TooltipProvider } from "./tooltip";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

const tooltip = () => document.querySelector("[data-slot=tooltip-content]");

describe("IconButton (plan 125)", () => {
  it("is named by its label, with nothing visible but the icon", async () => {
    const host = await render(<IconButton label="Archive" data-testid="a"><Archive /></IconButton>);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Archive");
    expect(button.dataset.testid).toBe("a");
    expect(button.textContent).toBe("");
    expect(tooltip()).toBeNull();
  });

  it("shows its name and shortcut in a tooltip on hover", async () => {
    const host = await render(<IconButton label="Archive" shortcut="e"><Archive /></IconButton>);
    const button = host.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const tip = tooltip()!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("Archive");
    expect(tip.querySelector("[data-slot=shortcut]")!.textContent).toBe("E");
  });

  it("ghost is the quiet toolbar icon; secondary is the bordered one", async () => {
    const host = await render(
      <>
        <IconButton label="A"><Archive /></IconButton>
        <IconButton label="B" variant="secondary" size="icon"><Archive /></IconButton>
      </>
    );
    const [ghost, secondary] = [...host.querySelectorAll("button")] as [HTMLButtonElement, HTMLButtonElement];
    expect(ghost.className).toContain("text-muted-foreground");
    expect(ghost.className).toContain("size-7");
    expect(secondary.className).toContain("border-border");
    expect(secondary.className).toContain("size-8");
  });

  it("passes clicks and disabled through", async () => {
    const onClick = vi.fn();
    const host = await render(<IconButton label="A" onClick={onClick} disabled><Archive /></IconButton>);
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
  });
});
