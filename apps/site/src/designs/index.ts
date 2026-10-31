import type { SiteDesign } from "../site";
import { Atelier } from "./atelier";
import { Bento } from "./bento";
import { Letter } from "./letter";
import { Lumen } from "./lumen";
import { Midnight } from "./midnight";
import type { HomeDesign } from "./types";

export const DESIGN_HOMES: Record<SiteDesign, HomeDesign> = { lumen: Lumen, atelier: Atelier, midnight: Midnight, bento: Bento, letter: Letter };
