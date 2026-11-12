/**
 * Terno's public pages (plan 190): the repository, its releases and its licence. Opened only when the user clicks
 * one (the system browser on desktop, a new tab on the web), so none of them is traffic of the app's own.
 */
const REPO = "https://github.com/luisiacc/terno";

export const TERNO_LINKS = {
  source: REPO,
  releases: `${REPO}/releases`,
  latest: `${REPO}/releases/latest`,
  license: `${REPO}/blob/main/LICENSE`,
} as const;

/** A version's release page; a build that isn't a release (no real commit, a 0.0.0) has none, so the list. */
export function releaseNotesUrl(version: string, sha?: string): string {
  if (sha === "dev" || !/^\d+\.\d+\.\d+/.test(version) || version === "0.0.0") return TERNO_LINKS.releases;
  return `${REPO}/releases/tag/v${encodeURIComponent(version)}`;
}
