import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { render, routes } from "./entry-server";

describe("prerendered pages", () => {
  for (const route of routes()) {
    it(`${route.path}: one h1, title, description, alt on every image, indexing as intended`, () => {
      const { head, body, lang } = render(route);
      const doc = new JSDOM(`<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`).window.document;
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      expect(doc.title.length).toBeGreaterThan(10);
      expect(doc.querySelector('meta[name="description"]')?.getAttribute("content")?.length).toBeGreaterThan(50);
      for (const img of doc.querySelectorAll("img")) expect(img.getAttribute("alt"), img.outerHTML).toBeTruthy();
      expect(doc.querySelector("main#main")).not.toBeNull();
      // no inline style or script: the CSP (style-src/script-src 'self') would refuse them
      expect(doc.querySelectorAll("[style]")).toHaveLength(0);
      expect([...doc.querySelectorAll("script")].every((s) => s.type === "application/ld+json")).toBe(true);
      const robots = doc.querySelector('meta[name="robots"]')?.getAttribute("content");
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
      if (route.noindex) {
        expect(robots).toBe("noindex");
        expect(canonical).toBeUndefined();
      } else {
        expect(robots).toBeUndefined();
        expect(canonical).toBe(`https://terno.app${route.path}`);
        expect(doc.querySelectorAll('link[rel="alternate"][hreflang]')).toHaveLength(3);
      }
      if (route.page === "home") {
        expect(doc.querySelector('a[href="/download/mac"]')).not.toBeNull();
        expect(doc.querySelector("#waitlist form[action='/api/waitlist']")).not.toBeNull();
      }
    });
  }

  it("only the four public pages per language are indexable; previews and the 404 aren't", () => {
    expect(routes().filter((r) => !r.noindex).map((r) => r.path)).toEqual(["/", "/privacy/", "/es/", "/es/privacy/"]);
  });

  it("the Spanish home page is in Spanish", () => {
    const es = routes().find((r) => r.path === "/es/")!;
    expect(render(es).body).toContain("Tu correo, a la medida.");
    expect(render(es).body).not.toContain("Your mail, made to measure.");
  });
});
