// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sparkles } from "../icons";
import { Announcement } from "./announcement";

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

describe("Announcement (plan 125)", () => {
  it("dismisses with a close named for what it does", async () => {
    const onClose = vi.fn();
    const host = await render(<Announcement icon={<Sparkles />} title="Title" description="Body" onClose={onClose} closeLabel="Hide for a week" />);
    const close = host.querySelector<HTMLButtonElement>("[data-slot=close-button]")!;
    expect(close.getAttribute("aria-label")).toBe("Hide for a week");
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("has no close without onClose; the icon is decorative", async () => {
    const host = await render(<Announcement icon={<Sparkles />} title="Title" />);
    expect(host.querySelector("[data-slot=close-button]")).toBeNull();
    expect(host.querySelector("svg")!.closest("[aria-hidden]")).not.toBeNull();
  });

  it("a status or group is named by its title; a plain one carries no name", async () => {
    const host = await render(
      <>
        <Announcement role="group" title="Keep forwarding?" titleProps={{ "data-testid": "t" }} />
        <Announcement title="Plain" />
      </>
    );
    const [group, plain] = [...host.querySelectorAll<HTMLElement>("[data-slot=announcement]")] as [HTMLElement, HTMLElement];
    const title = host.querySelector<HTMLElement>("[data-testid=t]")!;
    expect(group.getAttribute("aria-labelledby")).toBe(title.id);
    expect(plain.hasAttribute("aria-labelledby")).toBe(false);
  });
});
