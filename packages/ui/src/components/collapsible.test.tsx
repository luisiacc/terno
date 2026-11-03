// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "./accordion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./collapsible";

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

describe("Collapsible (plan 125)", () => {
  it("a button says whether its panel is open; a closed panel isn't rendered", async () => {
    const onOpenChange = vi.fn();
    const host = await render(
      <Collapsible onOpenChange={onOpenChange}>
        <CollapsibleTrigger>What's new</CollapsibleTrigger>
        <CollapsiblePanel>
          <p data-testid="notes">Faster search</p>
        </CollapsiblePanel>
      </Collapsible>,
    );
    const trigger = host.querySelector("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("What's new");
    expect(trigger.querySelector("[data-slot=collapsible-chevron]")).not.toBeNull();
    expect(host.querySelector("[data-testid=notes]")).toBeNull();
    await act(async () => trigger.click());
    expect(onOpenChange).toHaveBeenCalledWith(true, expect.anything());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.hasAttribute("data-panel-open")).toBe(true);
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(panel.querySelector("[data-testid=notes]")).not.toBeNull();
  });

  it("keepMounted: the closed panel stays, hidden; named, it is the region the trigger controls even closed", async () => {
    const host = await render(
      <Collapsible>
        <CollapsibleTrigger chevron={false} aria-controls="repairs">Messages needing repair</CollapsibleTrigger>
        <CollapsiblePanel keepMounted id="repairs" />
      </Collapsible>,
    );
    const trigger = host.querySelector("button")!;
    expect(trigger.querySelector("svg")).toBeNull();
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(true);
  });
});

describe("Accordion (plan 125)", () => {
  it("sections under headings; several open at once with multiple", async () => {
    const host = await render(
      <Accordion multiple defaultValue={[2]}>
        <AccordionItem value={1}>
          <AccordionTrigger level={4}>Work</AccordionTrigger>
          <AccordionPanel>Work's settings</AccordionPanel>
        </AccordionItem>
        <AccordionItem value={2}>
          <AccordionTrigger level={4}>Personal</AccordionTrigger>
          <AccordionPanel>Personal's settings</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect([...host.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Work", "Personal"]);
    const [work, personal] = [...host.querySelectorAll("button")];
    expect([work, personal].map((b) => b!.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(host.textContent).toContain("Personal's settings");
    await act(async () => work!.click());
    expect([work, personal].map((b) => b!.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(host.textContent).toContain("Work's settings");
  });
});
