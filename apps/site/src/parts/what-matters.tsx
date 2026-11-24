import type { SiteCopy } from "../copy";
import { ChevronRight } from "./icons";
import type { ShotName } from "./shot";

/**
 * “What matters” (plan 224), shared by the three designs: its picture and its benefits, in order. Each design lays them
 * out its own way, as Terno Pro's lead.
 */

export const WM_SHOT = "ai-what-matters" as const satisfies ShotName;
export const WM_BENEFITS = ["tasks", "urgent", "promises", "quiet"] as const satisfies readonly (keyof SiteCopy["whatMatters"]["benefits"])[];

/** the id each design gives “What matters” (inside Pro), so the hero's link can reach it */
export const WM_ANCHOR = "what-matters";

/**
 * The hero's link down to “What matters” (the owner, 2026-11-23: the first lines name it), above the title. Unstyled
 * structure; the design passes classes for the link and its tag.
 */
export function WhatMattersNews({ copy, className = "", tagClassName = "" }: { copy: SiteCopy; className?: string; tagClassName?: string }) {
  return (
    <a href={`#${WM_ANCHOR}`} className={className}>
      <span className={tagClassName}>{copy.hero.news.tag}</span>
      <span>{copy.hero.news.text}</span>
      <ChevronRight size="1.15em" aria-hidden="true" />
    </a>
  );
}
