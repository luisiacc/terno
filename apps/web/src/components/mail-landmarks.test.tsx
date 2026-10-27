// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { t } from "@terno/i18n";
import { setup } from "./draft-presentation-r1-harness";

it("keeps one main and the same list DOM, focus and scroll through layouts and covered pages", async () => {
  const h = await setup("list", true);
  const { useAppearance } = await import("~/lib/appearance");
  const mains = () => h.host.querySelectorAll('main, [role="main"]');
  const list = h.host.querySelector<HTMLElement>("#app-list")!;
  const section = h.host.querySelector<HTMLElement>("[data-list-section]")!;
  const draft = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!;
  const sameList = () => {
    expect(h.host.querySelector("#app-list")).toBe(list);
    expect(h.host.querySelector("[data-list-section]")).toBe(section);
    expect(h.host.querySelector('[data-testid="strip-item"]')).toBe(draft);
    expect(section.scrollTop).toBe(128);
    expect(mains()).toHaveLength(1);
    expect(mains()[0]!.querySelector('main, [role="main"]')).toBeNull();
  };
  try {
    section.scrollTop = 128; draft.focus();
    expect(mains()).toHaveLength(1);
    expect(mains()[0]).toBe(list);
    await act(async () => useAppearance.setState({ layout: "split" }));
    sameList();
    expect(list.getAttribute("aria-label")).toBe(t("list.label"));
    expect(list.contains(mains()[0]!)).toBe(false);
    expect(document.activeElement).toBe(draft);
    await act(async () => useAppearance.setState({ layout: "list" }));
    sameList();
    expect(document.activeElement).toBe(draft);
    expect(mains()[0]).toBe(list);
    for (const page of ["thread", "compose"] as const) {
      await act(async () => h.app.setApp({ readerOpen: true, compose: page === "compose" ? { key: h.key, seq: 0 } : null }));
      sameList();
      expect(section.hasAttribute("inert")).toBe(true);
      expect(mains()[0]!.contains(h.host.querySelector('[data-testid="list-page"]'))).toBe(true);
      expect(h.host.querySelector('[data-testid="list-page"]')?.getAttribute("data-page")).toBe(page);
    }
    await act(async () => h.app.setApp({ compose: null, readerOpen: false }));
    sameList();
    expect(section.hasAttribute("inert")).toBe(false);
  } finally { await h.cleanup(); }
});
