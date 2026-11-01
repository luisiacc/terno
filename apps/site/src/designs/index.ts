import type { SiteDesign } from "../site";
import { Letter } from "./letter";
import { Lumen } from "./lumen";
import { Midnight } from "./midnight";
import type { HomeDesign } from "./types";

export const DESIGN_HOMES: Record<SiteDesign, HomeDesign> = { lumen: Lumen, midnight: Midnight, letter: Letter };
