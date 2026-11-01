import type { SiteCopy } from "../copy";
import { GITHUB, ORIGIN, type Route } from "../site";

/** Everything search engines and link previews read (plan 97 §SEO). Rendered into <head> by the prerender step. */
export function Head({ route, copy, title, description }: { route: Route; copy: SiteCopy; title: string; description: string }) {
  const followsSystem = route.page === "home" && route.design !== "midnight";
  const url = `${ORIGIN}${route.path === "/404.html" ? "/" : route.path}`;
  const app = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Terno",
    applicationCategory: "CommunicationApplication",
    operatingSystem: "macOS",
    description: copy.meta.description,
    url: ORIGIN,
    image: `${ORIGIN}/og.jpg`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    codeRepository: GITHUB,
  };
  return (
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content={description} />
      {route.noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={url} />}
      {!route.noindex && route.alternate && (
        <>
          <link rel="alternate" hrefLang={copy.lang} href={url} />
          <link rel="alternate" hrefLang={copy.lang === "en" ? "es" : "en"} href={`${ORIGIN}${route.alternate}`} />
          <link rel="alternate" hrefLang="x-default" href={`${ORIGIN}${copy.lang === "en" ? route.path : route.alternate}`} />
        </>
      )}
      {/* the site is dark whatever the system says; only the Lumen and Letter previews follow it */}
      {followsSystem ? (
        <>
          <meta name="color-scheme" content="light dark" />
          <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
          <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111214" />
        </>
      ) : (
        <>
          <meta name="color-scheme" content="dark" />
          <meta name="theme-color" content={route.page === "home" ? "#08090b" : "#111214"} />
        </>
      )}
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Terno" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={`${ORIGIN}/og.jpg`} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={copy.alt.inbox} />
      <meta property="og:locale" content={copy.lang === "es" ? "es_ES" : "en_US"} />
      <meta name="twitter:card" content="summary_large_image" />
      {route.page === "home" && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(app).replace(/</g, "\\u003c") }} />}
    </>
  );
}
