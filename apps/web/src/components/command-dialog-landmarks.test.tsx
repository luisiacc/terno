// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandDialog } from "@terno/ui/components/command";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("keeps command metadata inside the reopened popup and removes it while closed", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (open: boolean) => act(async () => root.render(
    <StrictMode><CommandDialog open={open} title="Find a command" description="Search available commands">
      <button>Run command</button>
    </CommandDialog></StrictMode>,
  ));
  const metadata = () => document.querySelector('[data-slot="dialog-header"]');
  try {
    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(metadata()).toBeNull();
    for (let cycle = 0; cycle < 2; cycle++) {
      await render(true);
      const popup = document.querySelector('[role="dialog"]')!;
      expect(popup).not.toBeNull();
      for (const [attribute, text] of [["aria-labelledby", "Find a command"], ["aria-describedby", "Search available commands"]] as const) {
        const ids = popup.getAttribute(attribute)?.split(/\s+/) ?? [];
        expect(ids.length).toBeGreaterThan(0);
        const targets = ids.map((id) => document.getElementById(id));
        expect(targets.every((node) => node !== null && popup.contains(node))).toBe(true);
        expect(targets.map((node) => node?.textContent).join(" ")).toBe(text);
      }
      expect(popup.contains(metadata())).toBe(true);
      await render(false);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(metadata()).toBeNull();
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});
