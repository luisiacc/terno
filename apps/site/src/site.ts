/** terno.app's fixed facts (plan 97). */
export const ORIGIN = "https://terno.app";
export const GITHUB = "https://github.com/luisiacc/terno";
export const LICENSE_URL = `${GITHUB}/blob/main/LICENSE`;

export const DESIGNS = ["lumen", "midnight", "letter"] as const;
export type SiteDesign = (typeof DESIGNS)[number];
export const DESIGN_NAMES: Record<SiteDesign, string> = { lumen: "Lumen", midnight: "Midnight", letter: "Letter" };
/** the design `/` and `/es/` render; the others are previews at /designs/<id>/ until one is chosen */
export const SITE_DESIGN: SiteDesign = "midnight";

export type Lang = "en" | "es";
export type PageKind = "home" | "privacy" | "download" | "waitlist" | "404";
export interface Route {
  path: string;
  file: string;
  page: PageKind;
  lang: Lang;
  design: SiteDesign;
  /** a design preview or the 404: kept out of search engines and the sitemap */
  noindex: boolean;
  /** the same page in the other language */
  alternate: string | null;
}

const prefix = (lang: Lang) => (lang === "es" ? "/es" : "");
const pagePath = (page: Exclude<PageKind, "404">) => (page === "home" ? "/" : `/${page}/`);

export function routes(): Route[] {
  const list: Route[] = [];
  for (const lang of ["en", "es"] as const) {
    const other = lang === "en" ? "es" : "en";
    for (const page of ["home", "privacy", "download", "waitlist"] as const) {
      const path = `${prefix(lang)}${pagePath(page)}`;
      // download and waitlist are where a form or a missing release sends you, not search results
      list.push({ path, file: `${path.slice(1)}index.html`, page, lang, design: SITE_DESIGN, noindex: page === "download" || page === "waitlist", alternate: `${prefix(other)}${pagePath(page)}` });
    }
  }
  for (const design of DESIGNS) list.push({ path: `/designs/${design}/`, file: `designs/${design}/index.html`, page: "home", lang: "en", design, noindex: true, alternate: null });
  list.push({ path: "/404.html", file: "404.html", page: "404", lang: "en", design: SITE_DESIGN, noindex: true, alternate: null });
  return list;
}
