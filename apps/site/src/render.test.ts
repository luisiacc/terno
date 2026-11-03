import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { COPY } from "./copy";
import { render, routes } from "./entry-server";

describe("prerendered pages", () => {
  for (const route of routes()) {
    it(`${route.path}: one h1, title, description, alt on every image, indexing as intended`, () => {
      const { head, body, lang } = render(route);
      const doc = new JSDOM(`<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`).window.document;
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      expect(doc.title.length).toBeGreaterThan(10);
      expect(doc.querySelector('meta[name="description"]')?.getAttribute("content")?.length).toBeGreaterThan(50);
      for (const img of doc.querySelectorAll("img:not([data-lightbox-img])")) expect(img.getAttribute("alt"), img.outerHTML).toBeTruthy();
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
    expect(render(es).body).toContain("El último cliente de correo que probarás.");
    expect(render(es).body).not.toContain("The last email client you’ll try.");
  });
});

describe("screenshots", () => {
  it("every picture is in the page in light and dark, with its switch and enlarge button", () => {
    const home = routes().find((r) => r.path === "/")!;
    const doc = new JSDOM(render(home).body).window.document;
    const shots = [...doc.querySelectorAll("[data-shot]")];
    expect(shots.length).toBeGreaterThan(5);
    for (const shot of shots) {
      const modes = [...shot.querySelectorAll(":scope > img")].map((i) => i.getAttribute("data-mode"));
      expect(modes).toEqual(["light", "dark"]);
      for (const img of shot.querySelectorAll(":scope > img")) expect(img.getAttribute("data-full")).toMatch(/^\/shots\/.+-(light|dark)@2x\.webp$/);
      expect(shot.querySelectorAll("button[data-show]")).toHaveLength(2);
      expect(shot.querySelector("button[data-zoom]")).not.toBeNull();
    }
    expect(doc.querySelector("dialog[data-lightbox]")).not.toBeNull();
  });
});

describe("the main design", () => {
  it("/ and /es/ render Midnight, without the hero keycaps", () => {
    for (const path of ["/", "/es/"]) {
      const route = routes().find((r) => r.path === path)!;
      const out = render(route);
      expect(out.design).toBe("midnight");
      expect(out.body).not.toContain("mn-cap-big\">⌘</kbd><kbd class=\"mn-cap mn-cap-big\">K");
    }
  });
});

describe("the privacy policy", () => {
  const page = (path: string) => new JSDOM(render(routes().find((r) => r.path === path)!).body).window.document;

  it("has Google's Limited Use statement, linked to the User Data Policy, in both languages (OAuth verification)", () => {
    for (const path of ["/privacy/", "/es/privacy/"]) {
      const google = page(path).querySelector("section#google")!;
      expect(google.querySelector('a[href="https://developers.google.com/terms/api-services-user-data-policy"]')).not.toBeNull();
      expect(google.querySelector('a[href="https://myaccount.google.com/permissions"]')).not.toBeNull();
      expect(google.querySelector("code")?.textContent).toBe("gmail.modify");
    }
    expect(page("/privacy/").querySelector("section#google")!.textContent).toContain("will adhere to the Google API Services User Data Policy, including the Limited Use requirements");
  });

  it("every in-page link lands on a section, and both languages use the same anchors", () => {
    for (const path of ["/privacy/", "/es/privacy/"]) {
      const doc = page(path);
      const links = [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href")!.slice(1)).filter((id) => id !== "main");
      expect(links.length).toBeGreaterThan(COPY.en.pages.privacy.sections.length);
      for (const id of links) expect(doc.getElementById(id), id).not.toBeNull();
    }
    expect(COPY.es.pages.privacy.sections.map((s) => s.id)).toEqual(COPY.en.pages.privacy.sections.map((s) => s.id));
  });

  it("states what the code does, not more (the review's corrections)", () => {
    const doc = page("/privacy/");
    const section = (id: string) => doc.getElementById(id)!.textContent!;
    // update checks run whatever the setting; only the download is a choice
    expect(section("connections")).not.toContain("you control");
    expect(section("connections")).toContain("every few hours");
    // People API reads addresses to match photos (google-photos.ts), and the own picture is for sent mail
    expect(section("google")).toContain("email addresses and photos");
    expect(section("google")).toContain("the mail you send");
    // the connector is gated by a token file, not per app
    expect(section("agents")).toContain("key kept in your Terno folder");
    expect(section("agents")).not.toContain("set it up in");
    // reports carry coded breadcrumbs and device facts
    expect(section("errors")).toContain("the steps just before it");
    // a pre-upgrade backup outlives a removed account until it expires at a later open
    expect(section("delete")).toContain("14 days or more after the update");
  });

  it("no mark is left as literal text", () => {
    for (const path of ["/privacy/", "/es/privacy/"]) {
      const text = page(path).querySelector("main")!.textContent!;
      expect(text).not.toMatch(/\*\*|`|\]\(/);
    }
  });

  it("every home design links to it", () => {
    for (const route of routes().filter((r) => r.page === "home")) {
      const privacy = route.lang === "es" ? "/es/privacy/" : "/privacy/";
      expect(new JSDOM(render(route).body).window.document.querySelector(`a[href="${privacy}"]`), route.path).not.toBeNull();
    }
  });
});
