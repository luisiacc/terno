/**
 * terno.app's Worker (plan 96). It runs first for every request (Codex 1) so the www redirect and the headers
 * cover everything; static paths go straight to the assets.
 */
import { handleDownload } from "./download";
import { PRODUCTION_HOST, secure } from "./headers";
import { handleWaitlist, type WaitlistEnv } from "./waitlist";

export interface Env extends WaitlistEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === `www.${PRODUCTION_HOST}`) {
      url.hostname = PRODUCTION_HOST;
      return Response.redirect(url.toString(), 301);
    }
    let res: Response;
    if (url.pathname === "/api/waitlist") res = await handleWaitlist(req, env);
    else if (url.pathname === "/download/mac") res = await handleDownload(req);
    else if (url.pathname.startsWith("/api/")) res = new Response("Not Found", { status: 404 });
    else res = await env.ASSETS.fetch(req);
    return secure(res, url);
  },
} satisfies ExportedHandler<Env>;
