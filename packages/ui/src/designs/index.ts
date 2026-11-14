import { DEFAULT_DESIGN, type DesignId } from "@terno/core";
import { atelier } from "./atelier";
import { graphite } from "./graphite";
import { luma } from "./luma";
import { lumen } from "./lumen";
import { macos } from "./macos";
import { relief } from "./relief";
import type { DesignDefinition } from "./types";

export type { DesignDefinition, DesignVariants, TypeRole } from "./types";

/**
 * Every design, in the order Settings, first run and the palette show them (plan 173, the owner: Graphite second, macOS
 * last; plan 204: Relief beside Graphite, the two greys together). A test keeps it in sync with @terno/core DESIGN_IDS.
 */
export const DESIGNS: readonly DesignDefinition[] = [lumen, graphite, relief, atelier, luma, macos];

const BY_ID = new Map<string, DesignDefinition>(DESIGNS.map((d) => [d.id, d]));

/** A design by id; anything unknown is the default design. */
export function designById(id: string | null | undefined): DesignDefinition {
  return BY_ID.get(id ?? "") ?? BY_ID.get(DEFAULT_DESIGN)!;
}

export function isKnownDesign(id: string): id is DesignId {
  return BY_ID.has(id);
}
