import { renderToStaticMarkup } from "react-dom/server";
import { COPY } from "./copy";
import { DESIGN_HOMES } from "./designs";
import { Head } from "./parts/head";
import { SecondaryPage } from "./parts/pages";
import { Lightbox } from "./parts/lightbox";
import { PreviewBar } from "./parts/preview-bar";
import { routes, type Route } from "./site";

export { routes };

/** One route to its <head> and <body> markup (scripts/prerender.mjs puts them in the built index.html). */
export function render(route: Route): { head: string; body: string; lang: string; design: string } {
  const copy = COPY[route.lang];
  const p = copy.pages;
  const title = route.page === "home" ? copy.meta.title : `${route.page === "privacy" ? p.privacy.title : route.page === "download" ? p.download.title : route.page === "waitlist" ? p.waitlist.title : p.notFound.title} · Terno`;
  const description = route.page === "privacy" ? p.privacy.intro : copy.meta.description;
  const Home = DESIGN_HOMES[route.design];
  const preview = route.path.startsWith("/designs/");
  const body = route.page === "home" ? (
    <>
      <Home copy={copy} route={route} />
      <Lightbox copy={copy} />
      {preview && <PreviewBar current={route.design} copy={copy} />}
    </>
  ) : (
    <SecondaryPage route={route} copy={copy} />
  );
  return {
    head: renderToStaticMarkup(<Head route={route} copy={copy} title={title} description={description} />),
    body: renderToStaticMarkup(body),
    lang: route.lang,
    design: route.page === "home" ? route.design : "plain",
  };
}
