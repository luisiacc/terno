import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { COPY } from "./copy";
import { render, routes } from "./entry-server";
import { DESIGN_IDS } from "@terno/core";
import { DESIGNS } from "./site";
import { DESIGN_SHOTS } from "./parts/shot";
import shots from "./shots.json";
import { FILED_WINDOW, SHORTCUTS_WINDOW, VIEWPORT } from "../shots/windows";

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
        expect(doc.querySelector(`a[href="${route.lang === "es" ? "/download/mac?lang=es" : "/download/mac"}"]`)).not.toBeNull();
        expect(doc.querySelector("#waitlist form[action='/api/waitlist']")).not.toBeNull();
      }
    });
  }

  it("only the public pages per language are indexable (home, privacy, terms, the Linux packages); previews and the 404 aren't", () => {
    expect(routes().filter((r) => !r.noindex).map((r) => r.path)).toEqual(["/", "/privacy/", "/terms/", "/download/linux/", "/es/", "/es/privacy/", "/es/terms/", "/es/download/linux/"]);
  });

  it("every home design and every plain page links Privacy and Terms in its language; Terms bans illegal, abusive and NSFW generation (Creem's review)", () => {
    for (const route of routes()) {
      if (route.path.startsWith("/designs/")) continue;
      const doc = new JSDOM(render(route).body).window.document;
      const hrefs = new Set([...doc.querySelectorAll("footer a")].map((a) => a.getAttribute("href")));
      const es = route.lang === "es" ? "/es" : "";
      expect(hrefs.has(`${es}/privacy/`), route.path).toBe(true);
      expect(hrefs.has(`${es}/terms/`), route.path).toBe(true);
      // a plain page offers itself in the other language
      if (route.page !== "home" && route.alternate) expect(hrefs.has(route.alternate), route.path).toBe(true);
    }
    for (const lang of ["en", "es"] as const)
      for (const design of DESIGNS) {
        const doc = new JSDOM(render({ ...routes().find((r) => r.page === "home" && r.lang === lang)!, design }).body).window.document;
        expect([...doc.querySelectorAll("footer a")].some((a) => a.getAttribute("href") === (lang === "es" ? "/es/terms/" : "/terms/")), `${lang} ${design}`).toBe(true);
      }
    const bans = { en: [/may not use Terno/, /illegal content/, /abusive content/, /NSFW content/], es: [/No puedes usar Terno/, /contenido ilegal/, /contenido abusivo/, /NSFW \(no apto para el trabajo\)/] };
    for (const lang of ["en", "es"] as const) {
      const terms = new JSDOM(render(routes().find((r) => r.page === "terms" && r.lang === lang)!).body).window.document;
      const aup = terms.querySelector("section#acceptable-use")?.textContent ?? "";
      for (const ban of bans[lang]) expect(aup, `${lang} ${ban}`).toMatch(ban);
      expect(terms.querySelector('a[href="mailto:support@terno.app"]'), lang).not.toBeNull();
      // the privacy page's AI section points at the rules
      const privacy = new JSDOM(render(routes().find((r) => r.page === "privacy" && r.lang === lang)!).body).window.document;
      expect(privacy.querySelector(`section#ai a[href="${lang === "es" ? "/es" : ""}/terms/#acceptable-use"]`), lang).not.toBeNull();
    }
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

  it("every home design, in each language, offers the Mac and Linux downloads and the Windows waitlist (plan 254)", () => {
    for (const lang of ["en", "es"] as const)
      for (const design of DESIGNS) {
        const route = { ...routes().find((r) => r.path === (lang === "es" ? "/es/" : "/"))!, design };
        const page = new JSDOM(render(route).body).window.document;
        const copy = COPY[lang];
        const where = `${lang} ${design}`;
        const hrefs = [...page.querySelectorAll("a")].map((a) => a.getAttribute("href"));
        // the hero and the closing each have both
        expect(hrefs.filter((h) => h === (lang === "es" ? "/download/mac?lang=es" : "/download/mac")), where).toHaveLength(2);
        expect(hrefs.filter((h) => h === (lang === "es" ? "/es/download/linux/" : "/download/linux/")), where).toHaveLength(2);
        // the header's Download goes to the hero's buttons, not to one platform's file
        expect(page.getElementById("download")?.querySelector('a[href^="/download/mac"]'), where).not.toBeNull();
        expect(hrefs, where).toContain("#download");
        expect(page.body.textContent, where).toContain(`${copy.download.other} · ${copy.download.otherSub}`);
        // Windows only: no platform to choose, and the form says Windows
        const form = page.querySelector("#waitlist form")!;
        expect(form.querySelector("select"), where).toBeNull();
        expect(form.querySelector('input[name="platform"]')?.getAttribute("value"), where).toBe("windows");
      }
  });

  it("the Linux page has its own title and description, is indexed in each language, and its fallback page sends you to GitHub (plan 254)", () => {
    for (const lang of ["en", "es"] as const) {
      const path = lang === "es" ? "/es/download/linux/" : "/download/linux/";
      const route = routes().find((r) => r.path === path)!;
      expect(route.noindex, path).toBe(false);
      expect(route.alternate, path).toBe(lang === "es" ? "/download/linux/" : "/es/download/linux/");
      const { head, body } = render(route);
      const doc = new JSDOM(`<html><head>${head}</head><body>${body}</body></html>`).window.document;
      expect(doc.title).toBe(`${COPY[lang].pages.linux.title} · Terno`);
      expect(doc.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(COPY[lang].pages.linux.description);
      const fallback = new JSDOM(render(routes().find((r) => r.path === (lang === "es" ? "/es/download/" : "/download/"))!).body).window.document;
      // every release, not the latest: the latest is the one a download just failed to find a file in
      expect(fallback.querySelector('a[href="https://github.com/luisiacc/terno/releases"]'), lang).not.toBeNull();
      expect(fallback.querySelector("form"), lang).toBeNull();
    }
  });

  it("Midnight's local card pictures where mail lives, in each language: the Mac and what it keeps, the mail servers, no server of Terno's", () => {
    // Midnight by name, in each language (the home routes, whatever design is live at /)
    for (const [path, copy] of [["/", COPY.en], ["/es/", COPY.es]] as const) {
      const page = new JSDOM(render({ ...routes().find((r) => r.path === path)!, design: "midnight" }).body).window.document;
      const card = [...page.querySelectorAll("article")].find((a) => a.querySelector("h3")?.textContent === copy.features.local.title)!;
      const map = card.querySelector("[data-local-map]")!;
      expect(map.getAttribute("aria-hidden"), path).toBe("true");
      const m = copy.features.local.map;
      for (const words of [m.computer, ...Object.values(m.kept), m.link, m.servers, m.providers, m.ours]) expect(map.textContent, `${path} ${words}`).toContain(words);
    }
  });

  it("a design that shows one part of the app shows a section picture of it, never a window moved behind a frame", () => {
    const parts: Record<string, string[]> = {
      "/designs/lumen/": ["unified", "triage", "archive", "code", "palette", "snippets"],
      "/designs/midnight/": ["unified", "search", "filed", "palette", "snippets", "code", "shortcuts"],
      "/designs/letter/": ["search", "code", "palette"],
    };
    for (const [path, names] of Object.entries(parts)) {
      const page = new JSDOM(render(routes().find((r) => r.path === path)!).body).window.document;
      const used = [...new Set([...page.querySelectorAll('img[src*="-detail-"]')].map((i) => i.getAttribute("src")!.match(/\/shots\/(.+)-detail-/)![1]))];
      expect(used.sort(), path).toEqual([...names].sort());
      // the pictures framed by pixel offsets (plan 97) went stale whenever the app moved; none may come back
      expect(page.querySelectorAll('[class*="crop"]'), path).toHaveLength(0);
      // a wide section keeps 470px on a phone (site-wide), so that's the width it asks the browser for (Codex review)
      for (const img of page.querySelectorAll(".site-wide img")) expect(img.getAttribute("sizes"), `${path} ${img.getAttribute("src")}`).toMatch(/, 470px$/);
      // on a phone only Lumen's picture spans the designs' two columns; the others ask for half the width
      for (const [, name] of DESIGN_SHOTS.slice(1)) for (const img of page.querySelectorAll(`img[src="/shots/${name}-light.webp"]`)) expect(img.getAttribute("sizes"), `${path} ${name}`).toMatch(/, 45vw$/);
    }
    // every design shows each of the app's designs (the owner: "there are more styles and palettes now"): the list
    // that renders them is checked against the app's own, so a design added to or left out of either fails here
    expect(DESIGN_SHOTS.map(([d]) => d).sort()).toEqual([...DESIGN_IDS].sort());
    for (const path of Object.keys(parts)) {
      const page = new JSDOM(render(routes().find((r) => r.path === path)!).body).window.document;
      for (const [, name] of DESIGN_SHOTS) for (const mode of ["light", "dark"]) expect(page.querySelector(`img[src="/shots/${name}-${mode}.webp"]`), `${path} ${name}`).not.toBeNull();
    }
    // each is a part of the window it was framed from when it was taken (the shortcuts sheet's taller one, the filed
    // newsletter's shorter one), in both modes
    const windows: Record<string, { width: number; height: number }> = { shortcuts: SHORTCUTS_WINDOW, filed: FILED_WINDOW };
    for (const name of Object.values(parts).flat()) {
      for (const mode of ["light", "dark"]) {
        const size = (shots as Record<string, { width: number; height: number }>)[`${name}-detail-${mode}`];
        const window = windows[name] ?? VIEWPORT;
        expect(size, `${name}-detail-${mode}`).toBeDefined();
        expect(size!.width <= window.width && size!.height <= window.height && size!.width * size!.height < window.width * window.height, name).toBe(true);
      }
    }
  });
});

describe("Terno Pro (plan 97)", () => {
  const homes = routes().filter((r) => r.page === "home");
  const doc = (path: string) => new JSDOM(render(routes().find((r) => r.path === path)!).body).window.document;

  it("every home design has the section, its nav link, the six pictures with alt text, and no way to buy", () => {
    for (const route of homes) {
      const copy = COPY[route.lang];
      const page = new JSDOM(render(route).body).window.document;
      const pro = page.querySelector("section#pro")!;
      expect(pro, route.path).not.toBeNull();
      expect(page.querySelector('header a[href="#pro"]')?.textContent, route.path).toBe(copy.nav.pro);
      const title = page.getElementById(pro.getAttribute("aria-labelledby")!)!;
      expect(title.tagName).toBe("H2");
      expect(title.textContent).toBe(copy.pro.title);
      expect(pro.textContent).toContain(copy.pro.status);
      expect(pro.textContent).toContain(copy.pro.price);
      expect(pro.textContent).toContain(copy.pro.ownKey);
      for (const name of ["ai-reply", "ai-ask", "ai-followups", "ai-people", "ai-digest", "ai-summary"] as const) {
        const imgs = [...pro.querySelectorAll(`img[src^="/shots/${name}-"]`)];
        expect(imgs.map((i) => i.getAttribute("data-mode")), `${route.path} ${name}`).toEqual(["light", "dark"]);
        for (const img of imgs) expect(img.getAttribute("alt")).toBe(copy.alt[name]);
      }
      // the plan isn't sold yet (its features work on the user's own key): nothing to download, buy or start
      expect(pro.querySelectorAll('a[href^="/download"], form'), route.path).toHaveLength(0);
      expect([...pro.querySelectorAll("button")].every((b) => b.closest(".site-shot-tools")), route.path).toBe(true);
    }
  });

  it("the own-key note links to the privacy page's AI section, which exists in both languages", () => {
    for (const route of homes) {
      const privacy = route.lang === "es" ? "/es/privacy/" : "/privacy/";
      expect(new JSDOM(render(route).body).window.document.querySelector(`#pro a[href="${privacy}#ai"]`), route.path).not.toBeNull();
      expect(doc(privacy).querySelector("section#ai"), privacy).not.toBeNull();
    }
  });

  it("is in Spanish on /es/, and the honesty fixes are in both languages", () => {
    const es = doc("/es/");
    expect(es.querySelector("#pro h2")?.textContent).toBe("Que nada se te escape.");
    expect(es.querySelector("#pro")!.textContent).not.toContain(COPY.en.pro.body);
    expect(COPY.en.stats[1]!.label).toBe("Terno servers storing your mail");
    expect(COPY.en.features.local.body).toContain("syncs between your computer and your mail servers");
    expect(COPY.es.stats[1]!.label).toBe("servidores de Terno que guardan tu correo");
    for (const lang of ["en", "es"] as const) expect(COPY[lang].meta.description).toContain("Terno Pro");
  });
});

describe("People in Terno Pro (plan 288)", () => {
  it("every home design, in each language, shows People between the pairs, with its words and its own picture", () => {
    for (const lang of ["en", "es"] as const)
      for (const design of DESIGNS) {
        const route = { ...routes().find((r) => r.path === (lang === "es" ? "/es/" : "/"))!, design };
        const pro = new JSDOM(render(route).body).window.document.querySelector("section#pro")!;
        const p = COPY[lang].pro;
        const where = `${lang} ${design}`;
        // the features in order, after “What matters”' own (its title is an h3 too)
        const titles = [p.reply, p.ask, p.followups, p.people, p.digest, p.summaries].map((f) => f.title);
        const h3s = [...pro.querySelectorAll("h3")].filter((h) => titles.includes(h.textContent!));
        expect(h3s.map((h) => h.textContent), where).toEqual(titles);
        expect(pro.querySelector("#what-matters")!.compareDocumentPosition(h3s[0]!) & 4, where).toBe(4);
        const [followups, people, digest] = [h3s[2]!, h3s[3]!, h3s[4]!];
        const between = (e: Element, from: Element, to: Element) => !!(from.compareDocumentPosition(e) & 4) && !!(e.compareDocumentPosition(to) & 4);
        // its body and three points between its title and the digest's (Lumen puts its picture above the title)
        const texts = [...pro.querySelectorAll("p, li")];
        for (const words of [p.people.body, ...p.people.points]) {
          const at = texts.filter((e) => e.textContent === words);
          expect(at, `${where} ${words}`).toHaveLength(1);
          expect(between(at[0]!, people, digest), `${where} ${words}`).toBe(true);
        }
        // one picture, light and dark, between Follow-ups' title and the digest's, wide and cropped as its own
        const imgs = [...pro.querySelectorAll('img[src^="/shots/ai-people-"]')];
        expect(imgs.map((i) => i.getAttribute("data-mode")), where).toEqual(["light", "dark"]);
        for (const img of imgs) {
          expect(img.getAttribute("alt"), where).toBe(COPY[lang].alt["ai-people"]);
          expect(between(img, followups, digest), where).toBe(true);
          expect(img.closest(".site-pro-lead.site-pro-ai-people"), where).not.toBeNull();
        }
        // and it's People's own: no other feature's title or picture between it and People's title, either way round
        const [first, last] = people.compareDocumentPosition(imgs[0]!) & 4 ? [people, imgs[0]!] : [imgs[0]!, people];
        const others = [...pro.querySelectorAll("h3, img[data-mode=light]")].filter((e) => e !== people && e !== imgs[0]);
        expect(others.filter((e) => between(e, first, last)), where).toEqual([]);
      }
  });
});

describe("“What matters” (plan 224)", () => {
  const homes = routes().filter((r) => r.page === "home");

  it("every home design leads Terno Pro with it (it runs on AI): before the drafted reply, with its picture, benefits and Done", () => {
    for (const route of homes) {
      const copy = COPY[route.lang];
      const page = new JSDOM(render(route).body).window.document;
      const pro = page.querySelector("section#pro")!;
      const wm = pro.querySelector("#what-matters")!;
      expect(wm, route.path).not.toBeNull();
      // under Pro's own title (h2), its title an h3 and its benefits h4s, so the outline reads Pro › What matters › each
      const proTitle = page.getElementById(pro.getAttribute("aria-labelledby")!)!;
      expect(proTitle.tagName).toBe("H2");
      expect(proTitle.compareDocumentPosition(wm) & 4, route.path).toBe(4);
      // before the drafted reply's title and picture
      const reply = [...pro.querySelectorAll("h3")].find((h) => h.textContent === copy.pro.reply.title)!;
      expect(wm.compareDocumentPosition(reply) & 4, route.path).toBe(4);
      expect(wm.compareDocumentPosition(pro.querySelector('img[src^="/shots/ai-reply-"]')!) & 4, route.path).toBe(4);
      expect(wm.querySelector("h3")?.textContent, route.path).toBe(copy.whatMatters.title);
      expect(wm.textContent, route.path).toContain(copy.whatMatters.eyebrow);
      const imgs = [...wm.querySelectorAll('img[src^="/shots/ai-what-matters-"]')];
      expect(imgs.map((i) => i.getAttribute("data-mode")), route.path).toEqual(["light", "dark"]);
      for (const img of imgs) expect(img.getAttribute("alt")).toBe(copy.alt["ai-what-matters"]);
      // each benefit, its line right under its title
      const benefits = Object.values(copy.whatMatters.benefits);
      const h4s = [...wm.querySelectorAll("h4")];
      expect(h4s.map((h) => h.textContent), route.path).toEqual(benefits.map((b) => b.title));
      for (const [i, h4] of h4s.entries()) expect(h4.nextElementSibling?.textContent, `${route.path} ${i}`).toBe(benefits[i]!.body);
      for (const text of [copy.whatMatters.body, copy.whatMatters.done, copy.whatMatters.foot]) expect(wm.textContent, route.path).toContain(text);
      // its section lives in Pro only; the hero names it in one link, above the title (the owner, 2026-11-23), and the header doesn't
      expect(page.querySelectorAll('img[src^="/shots/ai-what-matters-"]'), route.path).toHaveLength(2);
      expect(page.querySelectorAll('header a[href="#what-matters"]'), route.path).toHaveLength(0);
      const news = [...page.querySelectorAll('a[href="#what-matters"]')];
      expect(news, route.path).toHaveLength(1);
      expect(news[0]!.textContent, route.path).toBe(copy.hero.news.tag + copy.hero.news.text);
      expect(copy.hero.news.text, route.path).toContain(copy.whatMatters.eyebrow);
      const h1 = page.querySelector("h1")!;
      expect(news[0]!.compareDocumentPosition(h1) & 4, route.path).toBe(4);
      expect(h1.compareDocumentPosition(pro) & 4, route.path).toBe(4);
    }
  });

  it("the hero's subtitle ends with the AI, in every home design, without promising a plan on sale", () => {
    for (const route of homes) {
      const copy = COPY[route.lang];
      const page = new JSDOM(render(route).body).window.document;
      expect([...page.querySelectorAll("p")].some((p) => p.textContent === copy.hero.subtitle), route.path).toBe(true);
      expect(copy.hero.subtitle, route.path).toMatch(route.lang === "en" ? /Turn on AI, .+\.$/ : /Activa la IA, .+\.$/);
    }
    for (const lang of ["en", "es"] as const) expect(JSON.stringify(COPY[lang].hero)).not.toMatch(/Pro|\$|US\$/);
  });

  it("names the view as the app does, and nothing promises the old Today", () => {
    for (const lang of ["en", "es"] as const) {
      const c = COPY[lang];
      expect(c.whatMatters.eyebrow).toBe(lang === "en" ? "What matters" : "Lo importante");
      expect(c.meta.description).toContain(lang === "en" ? "“What matters”" : "«Lo importante»");
      expect(JSON.stringify(c)).not.toMatch(/Twelve at most|Doce como máximo|ai-today/);
    }
  });
});

describe("AI agents over MCP (plan 97)", () => {
  const homes = routes().filter((r) => r.page === "home");

  it("every home design shows it in its language: the heading, the real setup command and tool, the example, and a link to the privacy page's section on agents", () => {
    for (const route of homes) {
      const copy = COPY[route.lang];
      const page = new JSDOM(render(route).body).window.document;
      const heading = [...page.querySelectorAll("h2, h3")].find((h) => h.textContent === copy.features.agents.title);
      expect(heading, route.path).toBeDefined();
      const section = heading!.closest("section, article")!;
      const text = section.textContent!;
      expect(text).toContain(copy.features.agents.body);
      expect(text).toContain("claude mcp add terno -- /Applications/Terno.app/…/terno-mcp");
      expect(text).toContain("terno · search_emails");
      for (const line of [copy.features.agents.demo.ask, copy.features.agents.demo.answer]) expect(text).toContain(line);
      const privacy = route.lang === "es" ? "/es/privacy/" : "/privacy/";
      expect(section.querySelector(`a[href="${privacy}#agents"]`), route.path).not.toBeNull();
      expect(new JSDOM(render(routes().find((r) => r.path === privacy)!).body).window.document.querySelector("section#agents"), privacy).not.toBeNull();
    }
  });

  it("promises only what the connector is: a local (stdio) MCP server, for apps on the same computer (Codex review)", () => {
    expect(COPY.en.features.agents.body).toContain("on your computer that runs local MCP servers");
    expect(COPY.es.features.agents.body).toContain("de tu ordenador que use servidores MCP locales");
    for (const lang of ["en", "es"] as const) expect(JSON.stringify(COPY[lang].features.agents)).not.toMatch(/any (app|MCP)|cualquier app/);
  });

  it("is in Spanish on /es/", () => {
    const es = new JSDOM(render(routes().find((r) => r.path === "/es/")!).body).window.document;
    expect(es.body.textContent).toContain(COPY.es.features.agents.demo.ask);
    expect(es.body.textContent).not.toContain(COPY.en.features.agents.demo.ask);
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

  it("plan 258: asks Google for the profile and Gmail only: no contacts, no People API, no Photos from Google, in either language", () => {
    for (const path of ["/privacy/", "/es/privacy/"]) {
      const doc = page(path);
      const google = doc.querySelector("section#google")!;
      expect(google.querySelectorAll("ul > li")).toHaveLength(2);
      expect(doc.body.textContent).not.toMatch(/your contacts|contacts’|other contacts|tus contactos|otros contactos|People API|Photos from Google|Fotos de Google/i);
    }
    expect(page("/privacy/").body.textContent).toContain("Last updated: November 24, 2026");
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
    // plan 258: Terno asks Google for its profile and Gmail only; the profile picture isn't used
    expect(section("google")).toContain("not the picture");
    // plan 125: removal withdraws the grant
    expect(section("google")).toContain("withdraws Terno’s access at Google");
    // the connector is gated by a token file, not per app
    expect(section("agents")).toContain("key kept in your Terno folder");
    expect(section("agents")).not.toContain("set it up in");
    // reports carry coded breadcrumbs and device facts; "Always" sends without the preview, past unanswered ones too
    expect(section("errors")).toContain("the steps just before it");
    expect(section("errors")).toContain("Always, which sends each report without asking");
    expect(section("errors")).toContain("a random ID for that run of Terno");
    // plan 255: there is no copy of the mailbox before an update, so none outlives a removed account
    expect(section("delete")).not.toMatch(/copy|backup/i);
    // the key goes to its provider with each request; the work is split only between Claude and OpenAI, when chosen
    expect(section("ai")).toContain("is sent only to that provider");
    expect(section("ai")).toContain("If you choose Anthropic or OpenAI and save a key for both");
    // the connector is a Mac and Linux one (a shell launcher and a Unix socket)
    expect(section("agents")).toContain("it isn’t on Windows yet");
  });

  it("the contact is a mailbox Google's consent screen can also use (plan 124)", () => {
    for (const path of ["/privacy/", "/es/privacy/"]) {
      const link = page(path).querySelector<HTMLAnchorElement>("#contact a[href^='mailto:']")!;
      expect(link.getAttribute("href")).toBe("mailto:privacy@terno.app");
      expect(link.textContent).toBe("privacy@terno.app");
    }
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
