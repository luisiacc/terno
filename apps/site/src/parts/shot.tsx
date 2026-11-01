import manifest from "../shots.json";
import type { SiteCopy } from "../copy";
import { Maximize, Moon, Sun } from "./icons";

export type ShotName = keyof SiteCopy["alt"];
const size = (name: string) => (manifest as Record<string, { width: number; height: number }>)[name];

/**
 * A screenshot of the app (plan 97, `pnpm --filter @terno/site shots`), taken in light and dark. Both are in the
 * page; CSS shows the one matching the visitor's system (Midnight: dark), and the switch at the bottom right
 * (client.ts) shows the other. Hidden <img>s aren't fetched, so the switch costs nothing until used. A click on the
 * picture or the enlarge button opens it full size. WebP at 1× and 2×, sized so nothing shifts as it loads.
 * `className` goes on both images (the designs crop with it). The tools sit at the bottom right of the nearest
 * positioned ancestor: the design's frame.
 */
export function Shot({ name, copy, eager, sizes = "(min-width: 1280px) 1200px, 100vw", className }: { name: ShotName; copy: SiteCopy; eager?: boolean; sizes?: string; className?: string }) {
  const img = (mode: "light" | "dark") => {
    const base = `${name}-${mode}`;
    const dims = size(base)!;
    return (
      <img
        data-mode={mode}
        data-full={`/shots/${base}@2x.webp`}
        src={`/shots/${base}.webp`}
        srcSet={`/shots/${base}.webp ${dims.width}w, /shots/${base}@2x.webp ${dims.width * 2}w`}
        sizes={sizes}
        width={dims.width}
        height={dims.height}
        alt={copy.alt[name]}
        // lazy even for the hero: a hidden lazy image is never fetched, so only the shown mode downloads (Codex
        // review 2.3); high priority still puts the hero first
        loading="lazy"
        decoding="async"
        {...(eager && { fetchPriority: "high" as const })}
        className={className}
      />
    );
  };
  return (
    <span className="site-shot" data-shot>
      {img("light")}
      {img("dark")}
      <span className="site-shot-tools">
        <span role="group" aria-label={copy.shot.appearance} className="site-shot-modes">
          <button type="button" data-show="light" aria-pressed="false" title={copy.shot.light}>
            <Sun size={14} aria-label={copy.shot.light} role="img" />
          </button>
          <button type="button" data-show="dark" aria-pressed="false" title={copy.shot.dark}>
            <Moon size={14} aria-label={copy.shot.dark} role="img" />
          </button>
        </span>
        <button type="button" data-zoom title={copy.shot.enlarge}>
          <Maximize size={14} aria-label={copy.shot.enlarge} role="img" />
        </button>
      </span>
    </span>
  );
}
