import type { Lang } from "../site";
import { en, type SiteCopy } from "./en";
import { es } from "./es";

export type { SiteCopy };
export const COPY: Record<Lang, SiteCopy> = { en, es };
