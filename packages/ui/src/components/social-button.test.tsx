// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SocialButton } from "./social-button";

describe("SocialButton (BoardUI's, plan 276)", () => {
  it("is the outline button at BoardUI's medium, the provider's own mark first, hidden from assistive tech", () => {
    for (const [brand, name] of [["google", "Google"], ["microsoft", "Microsoft"]] as const) {
      const html = renderToStaticMarkup(<SocialButton brand={brand}>Continue with {name}</SocialButton>);
      const host = document.createElement("div");
      host.innerHTML = html;
      const button = host.querySelector("button")!;
      // the outline's card and edge, at lg's 36 px, filling its column
      for (const c of ["bg-card", "border-(--depth-edge)", "h-9", "w-full"]) expect(button.classList, c).toContain(c);
      const mark = button.firstElementChild!;
      expect(mark.getAttribute("data-provider-mark")).toBe(name);
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      // the company's colors, not the ink
      expect([...mark.querySelectorAll("path")].every((p) => /^#[0-9a-f]{6}$/.test(p.getAttribute("fill")!))).toBe(true);
      expect(button.textContent).toBe(`Continue with ${name}`);
    }
  });

  it("loading puts the spinner in the mark's place; the words stay", () => {
    for (const [brand, name] of [["google", "Google"], ["microsoft", "Microsoft"]] as const) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<SocialButton brand={brand} loading>Continue with {name}</SocialButton>);
      const button = host.querySelector("button")!;
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.querySelector("[data-provider-mark]")).toBeNull();
      // the spinner first, hidden (the button says it's busy), then the words, not hidden behind an overlay
      expect(button.firstElementChild!.getAttribute("data-slot")).toBe("spinner");
      expect(button.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
      expect(button.textContent).toBe(`Continue with ${name}`);
      expect(button.querySelector(".opacity-0")).toBeNull();
    }
  });
});
