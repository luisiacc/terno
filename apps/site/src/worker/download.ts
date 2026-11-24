/**
 * The downloads (plans 97, 254): each path below is a 302 to its file in the latest release on GitHub, the newest
 * that is neither a draft nor a prerelease (GitHub's own "latest release", as its API documents it). With none, a
 * missing file, or GitHub unreachable, the page that says where else to get it, in the visitor's language
 * (`?lang=es`): /download/ for the Mac, /download/linux/ for a Linux package. One lookup serves every path; it's
 * cached for 10 minutes (a failure for 1), and clicks that arrive while it runs wait for that one.
 */
export const REPO = "luisiacc/terno";

const VERSION = String.raw`\d+\.\d+\.\d+`;
/** each download path and the release file it names (apps/desktop/scripts/release-assets.mjs makes them) */
export const TARGETS = {
  "/download/mac": new RegExp(`^Terno-${VERSION}-arm64\\.dmg$`),
  "/download/linux/deb": new RegExp(`^Terno-${VERSION}-linux-amd64\\.deb$`),
  "/download/linux/deb-arm64": new RegExp(`^Terno-${VERSION}-linux-arm64\\.deb$`),
  "/download/linux/rpm": new RegExp(`^Terno-${VERSION}-linux-x86_64\\.rpm$`),
  "/download/linux/rpm-arm64": new RegExp(`^Terno-${VERSION}-linux-aarch64\\.rpm$`),
} as const;
export type Target = keyof typeof TARGETS;
export const isTarget = (path: string): path is Target => Object.hasOwn(TARGETS, path);

interface Release {
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}
type Picks = Partial<Record<Target, string>>;

/** The release's file for each target: only a stable release's, and only from GitHub's own download host. */
export function pickAssets(release: Release | null): Picks {
  const picks: Picks = {};
  if (!release || release.draft || release.prerelease) return picks;
  for (const [target, file] of Object.entries(TARGETS) as [Target, RegExp][]) {
    const asset = release.assets.find((a) => file.test(a.name));
    if (asset?.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)) picks[target] = asset.browser_download_url;
  }
  return picks;
}

const CACHE_KEY = "https://cache.terno.app/download/latest";
/** the lookup in flight in this isolate: a rush of clicks on a cold cache asks GitHub once */
let inflight: Promise<Picks> | null = null;

async function lookup(fetcher: typeof fetch, cache: Cache | null): Promise<Picks> {
  const cached = await cache?.match(new Request(CACHE_KEY));
  if (cached) return (await cached.json()) as Picks;
  let picks: Picks = {};
  // a failed lookup is remembered for a minute too, so an outage or GitHub's rate limit isn't hit on every click
  let ttl = 60;
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "terno.app" } });
    if (res.ok) {
      picks = pickAssets((await res.json()) as Release);
      ttl = 600;
    }
  } catch {}
  await cache?.put(new Request(CACHE_KEY), Response.json(picks, { headers: { "Cache-Control": `max-age=${ttl}` } }));
  return picks;
}

export async function handleDownload(req: Request, fetcher: typeof fetch = fetch, cache: Cache | null = typeof caches !== "undefined" ? caches.default : null): Promise<Response> {
  const url = new URL(req.url);
  const target = url.pathname as Target;
  inflight ??= lookup(fetcher, cache).finally(() => (inflight = null));
  const found = (await inflight)[target];
  if (found) return Response.redirect(found, 302);
  const lang = url.searchParams.get("lang") === "es" ? "/es" : "";
  return Response.redirect(`${url.origin}${lang}${target === "/download/mac" ? "/download/" : "/download/linux/"}`, 302);
}
