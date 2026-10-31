import { getApp, setApp } from "~/state/app";
import { draftKeyOf } from "./draft-commands";

/** Plan 88: the draft the palette was opened from (an object property: the React Compiler note on module lets). */
export const paletteFrom: { draftKey: string | null } = { draftKey: null };

/** ⌘K: opens the palette, remembering the draft that had focus; closes it when it's open. */
export function togglePalette(): void {
  if (getApp().dialog === "palette") return setApp({ dialog: null });
  paletteFrom.draftKey = draftKeyOf(document.activeElement);
  setApp({ dialog: "palette" });
}
