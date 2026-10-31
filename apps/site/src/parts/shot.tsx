import manifest from "../shots.json";
import type { SiteCopy } from "../copy";

export type ShotName = keyof SiteCopy["alt"];
const size = (name: string) => (manifest as Record<string, { width: number; height: number }>)[name];

/**
 * A screenshot of the app (plan 96, `pnpm --filter @terno/site shots`): WebP at 1× and 2×, the dark capture when
 * the visitor's system is dark (where one exists), explicit size so nothing shifts as it loads. `mode` pins one.
 */
export function Shot({ name, copy, mode, eager, sizes = "(min-width: 1280px) 1200px, 100vw", className }: { name: ShotName; copy: SiteCopy; mode?: "light" | "dark"; eager?: boolean; sizes?: string; className?: string }) {
  const light = size(`${name}-light`) ? `${name}-light` : `${name}-dark`;
  const dark = size(`${name}-dark`) ? `${name}-dark` : light;
  const base = mode === "dark" ? dark : mode === "light" ? light : light;
  const dims = size(base)!;
  const set = (b: string) => `/shots/${b}.webp ${size(b)!.width}w, /shots/${b}@2x.webp ${size(b)!.width * 2}w`;
  return (
    <picture>
      {!mode && dark !== light && <source media="(prefers-color-scheme: dark)" srcSet={set(dark)} sizes={sizes} />}
      <img
        src={`/shots/${base}.webp`}
        srcSet={set(base)}
        sizes={sizes}
        width={dims.width}
        height={dims.height}
        alt={copy.alt[name]}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        {...(eager && { fetchPriority: "high" as const })}
        className={className}
      />
    </picture>
  );
}
