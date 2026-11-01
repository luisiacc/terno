/**
 * GET /download/mac (plan 97): the newest published, stable release's Apple-silicon DMG on GitHub. With none
 * (drafts and nightlies don't count), or GitHub unreachable, the /download/ page, which says the first build is
 * on its way. The lookup is cached for 10 minutes so a launch-day rush doesn't hit GitHub's rate limit.
 */
export const REPO = "luisiacc/terno";
const DMG = /^Terno-\d+\.\d+\.\d+-arm64\.dmg$/;

interface Release {
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export function pickDmg(releases: Release[]): string | null {
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const asset = r.assets.find((a) => DMG.test(a.name));
    if (asset?.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)) return asset.browser_download_url;
  }
  return null;
}

export async function handleDownload(req: Request, fetcher: typeof fetch = fetch, cache: Cache | null = typeof caches !== "undefined" ? caches.default : null): Promise<Response> {
  const url = new URL(req.url);
  const fallback = () => Response.redirect(`${url.origin}/download/`, 302);
  const key = new Request(`https://cache.terno.app/download/mac`);
  const cached = await cache?.match(key);
  if (cached) {
    const target = await cached.text();
    return target ? Response.redirect(target, 302) : fallback();
  }
  let target: string | null = null;
  // a failed lookup is remembered for a minute too, so an outage or GitHub's rate limit isn't hit on every click
  let ttl = 60;
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json", "user-agent": "terno.app" } });
    if (res.ok) {
      target = pickDmg((await res.json()) as Release[]);
      ttl = 600;
    }
  } catch {}
  await cache?.put(key, new Response(target ?? "", { headers: { "Cache-Control": `max-age=${ttl}` } }));
  return target ? Response.redirect(target, 302) : fallback();
}
