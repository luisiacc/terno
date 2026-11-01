// plan 96: every route to static HTML in dist/ (the client build's index.html is the template), then the sitemap
// and robots.txt. Run by `pnpm build` after both Vite builds.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const { render, routes } = await import(pathToFileURL(join(root, ".ssr", "entry-server.js")).href);

const ORIGIN = "https://terno.app";
const template = readFileSync(join(dist, "index.html"), "utf8");
const all = routes();
for (const route of all) {
  const { head, body, lang, design } = render(route);
  const html = template.replace("<!--lang-->", lang).replace("<!--design-->", design).replace("<!--head-->", head).replace("<!--body-->", body);
  const file = join(dist, route.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

const indexed = all.filter((r) => !r.noindex);
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${indexed
    .map((r) => `  <url><loc>${ORIGIN}${r.path}</loc>${r.alternate ? `<xhtml:link rel="alternate" hreflang="${r.lang === "en" ? "es" : "en"}" href="${ORIGIN}${r.alternate}"/>` : ""}</url>`)
    .join("\n")}\n</urlset>\n`,
);
writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
console.log(`prerendered ${all.length} pages (${indexed.length} in the sitemap)`);
