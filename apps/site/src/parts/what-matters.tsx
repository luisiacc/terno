import type { SiteCopy } from "../copy";
import type { ShotName } from "./shot";

/**
 * “What matters” (plan 224), shared by the three designs: its picture and its benefits, in order. Each design lays them
 * out its own way, as the first section after the hero.
 */

export const WM_SHOT = "ai-what-matters" as const satisfies ShotName;
export const WM_BENEFITS = ["tasks", "urgent", "promises", "quiet"] as const satisfies readonly (keyof SiteCopy["whatMatters"]["benefits"])[];
