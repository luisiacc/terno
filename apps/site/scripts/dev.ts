/**
 * `pnpm --filter @terno/site dev` (plan 97): every page rendered on request through Vite (SSR + HMR'd CSS), so an
 * edit shows on reload. The deployed site is the prerendered build (`pnpm build`); this is only for working on it.
 */
import { readFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { join } from "node:path";
import { createServer } from "vite";

const root = join(import.meta.dirname, "..");
const first = Number(process.env.SITE_DEV_PORT ?? 5190);
// HMR rides on the page server, so there is no second port (24678) to collide with another Vite.
const server = http();
const vite = await createServer({ root, server: { middlewareMode: true, ws: { server } }, appType: "custom" });

server.on("request", (req, res) => {
  vite.middlewares(req, res, async () => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const mod = (await vite.ssrLoadModule("/src/entry-server.tsx")) as typeof import("../src/entry-server");
      const routes = mod.routes();
      const want = path.endsWith("/") || path.endsWith(".html") ? path : `${path}/`;
      const route = routes.find((r) => r.path === want) ?? routes.find((r) => r.page === "404")!;
      const { head, body, lang, design } = mod.render(route);
      const template = await vite.transformIndexHtml(path, readFileSync(join(root, "index.html"), "utf8"));
      res.statusCode = route.page === "404" ? 404 : 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(template.replace("<!--lang-->", lang).replace("<!--design-->", design).replace("<!--head-->", head).replace("<!--body-->", body));
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      res.statusCode = 500;
      res.end(String((e as Error).stack));
    }
  });
});

// A taken port (another checkout, another dev server) moves us to the next one rather than failing.
let port = first;
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE" || port - first >= 20) throw e;
  server.listen(++port, "127.0.0.1");
});
server.on("listening", () => console.log(`terno.app dev: http://127.0.0.1:${port}/  (designs: /designs/<id>/)`));
server.listen(port, "127.0.0.1");
