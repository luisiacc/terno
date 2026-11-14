/**
 * How controls stand off the surface (plan 204): a design picks one preset, and generate.ts writes it as the `--depth-*`
 * variables of its `[data-design]` block, which the controls read in place of literal shadows. Token references only (the
 * palette's shadow colour, highlight, rim and edges), never a colour, and never a `@theme` alias such as `--shadow-xs`:
 * those resolve at the root, so a nested preview in another palette would draw the outer one's (Codex review).
 *
 * `flat` is exactly what every control drew before plan 204, so the designs that use it render as they did.
 * `relief` is the owner's two reference widgets: raised things ringed by a dark rim with a white one inside it, lit along
 * the top edge and casting a short shadow; recessed things shaded at the top with a light lip below; words on raised
 * neutral controls pressed into them.
 */

export const DEPTH_IDS = ["flat", "relief"] as const;
export type DepthId = (typeof DEPTH_IDS)[number];

export const DEPTH_VARS = [
  /** a neutral raised control with a border of its own (an outline button, Lumen's compose pill): its lift, its fill's
   * light (a background image over its colour), and its border at rest and when firm (hover, open, pressed) */
  "--depth-raised",
  "--depth-raised-sheen",
  "--depth-edge",
  "--depth-edge-firm",
  /** the segmented control's chosen item, which has no border (its rim is in the shadow), in light and in dark */
  "--depth-segment",
  "--depth-segment-dark",
  /** a filled (primary) button, and Send's group */
  "--depth-ink",
  /** a checkbox or radio, off and on */
  "--depth-box",
  "--depth-box-on",
  /** the switch: its thumb and the thumb's chip (an opacity), its track's fill when off (light, dark) and its track's
   * shadow off and on; in dark, the thumb's fill from its top to its foot. Relief's off track is the picture's pale one,
   * its rim in the 3:1 control edge, and its dark thumb a soft grey rather than the brightest thing on screen */
  "--depth-thumb",
  "--depth-thumb-dark",
  "--depth-thumb-dark-shade",
  "--depth-thumb-chip",
  "--depth-track",
  "--depth-track-dark",
  "--depth-switch-off",
  "--depth-switch-on",
  /** a recessed track: the switch's (off), the segmented control's, a progress bar's */
  "--depth-well",
  /** a filled field (search, text fields), sunk a little */
  "--depth-field",
  /** a card of rows (Settings' groups): its lift under its ring, and its fill's light */
  "--depth-card",
  "--depth-card-sheen",
  /** the sidebar's chosen item */
  "--depth-nav",
  /** a text shadow for words on a raised neutral control */
  "--emboss",
] as const;
export type DepthVar = (typeof DEPTH_VARS)[number];

const mix = (token: string, pct: number) => `color-mix(in oklab, var(${token}) ${pct}%, transparent)`;

/** Tailwind's shadow-xs (globals.css --shadow-xs), written out so it takes the palette where it's drawn */
const XS = `0 1px 2px 0 ${mix("--shadow-color", 50)}`;
const NONE = "0 0 transparent";

/** Raised, inside a border that is its rim: a white ring, the lit top edge, a contact shadow and a soft drop */
const RAISED = `inset 0 0 0 1px ${mix("--highlight", 70)}, inset 0 1px var(--highlight), 0 1px 1px var(--shadow-color), 0 3px 8px -3px var(--shadow-color)`;
/** The same with its rim drawn in the shadow, for a raised thing without a border */
const RIMMED = `0 0 0 1px var(--depth-rim), ${RAISED}`;
/** The ink, lit along its top edge more faintly (white on black reads strong), over the same shadows */
const INK = `0 0 0 1px var(--depth-rim), inset 0 1px ${mix("--highlight", 40)}, 0 1px 2px var(--shadow-color), 0 4px 10px -3px var(--shadow-color)`;
/** Shaded at the top, ringed faintly, a light lip along the bottom edge */
const WELL = `inset 0 1px 2px var(--shadow-color), inset 0 0 0 1px ${mix("--shadow-color", 60)}, 0 1px var(--highlight)`;

export const DEPTHS: Record<DepthId, Record<DepthVar, string>> = {
  flat: {
    "--depth-raised": XS,
    "--depth-raised-sheen": "none",
    "--depth-edge": "var(--border)",
    "--depth-edge-firm": "var(--input)",
    "--depth-segment": XS,
    "--depth-segment-dark": "inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)",
    "--depth-ink": "inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)",
    "--depth-box": XS,
    "--depth-box-on": "inset 0 1px var(--highlight)",
    "--depth-thumb": `0 3px 3px 0 ${mix("--shadow-color", 30)}, 0 0.75px 0 0 ${mix("--shadow-color", 50)}`,
    "--depth-thumb-dark": "var(--foreground)",
    "--depth-thumb-dark-shade": "color-mix(in oklab, var(--foreground) 88%, var(--background))",
    "--depth-thumb-chip": "1",
    "--depth-track": "var(--control-edge)",
    "--depth-track-dark": "color-mix(in oklab, var(--control-edge) 80%, transparent)",
    "--depth-switch-off": NONE,
    "--depth-switch-on": "inset 0 1px var(--highlight)",
    "--depth-well": NONE,
    "--depth-field": NONE,
    "--depth-card": NONE,
    "--depth-card-sheen": "none",
    "--depth-nav": NONE,
    "--emboss": "none",
  },
  relief: {
    "--depth-raised": RAISED,
    "--depth-raised-sheen": `linear-gradient(to bottom, ${mix("--highlight", 55)}, transparent 70%)`,
    "--depth-edge": "var(--depth-rim)",
    "--depth-edge-firm": "var(--control-edge)",
    "--depth-segment": RIMMED,
    "--depth-segment-dark": RIMMED,
    "--depth-ink": INK,
    "--depth-box": `inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)`,
    "--depth-box-on": `0 0 0 0.5px var(--depth-rim), inset 0 1px ${mix("--highlight", 40)}, 0 1px 2px var(--shadow-color), 0 2px 5px -2px var(--shadow-color)`,
    "--depth-thumb": `0 0 0 1px var(--depth-rim), inset 0 0 0 1.5px var(--highlight), 0 1px 2px var(--shadow-color), 0 3px 6px -2px var(--shadow-color)`,
    // the picture's plain disc: no chip
    "--depth-thumb-dark": "color-mix(in oklab, var(--foreground) 68%, var(--background))",
    "--depth-thumb-dark-shade": "color-mix(in oklab, var(--foreground) 52%, var(--background))",
    "--depth-thumb-chip": "0",
    "--depth-track": "color-mix(in oklab, var(--control-edge) 50%, var(--background))",
    "--depth-track-dark": "color-mix(in oklab, var(--control-edge) 40%, var(--background))",
    "--depth-switch-off": `inset 0 1px 2px var(--shadow-color), inset 0 0 0 1px var(--control-edge), 0 1px var(--highlight)`,
    "--depth-switch-on": `inset 0 1px 2px ${mix("--shadow-color", 80)}, inset 0 0 0 1px var(--depth-rim), 0 1px var(--highlight)`,
    "--depth-well": WELL,
    "--depth-field": `inset 0 1px 2px ${mix("--shadow-color", 70)}, 0 1px ${mix("--highlight", 70)}`,
    "--depth-card": `inset 0 1px var(--highlight), 0 1px 2px ${mix("--shadow-color", 60)}, 0 12px 32px -14px var(--shadow-color)`,
    "--depth-card-sheen": `linear-gradient(to bottom, ${mix("--highlight", 25)}, transparent 120px)`,
    // the owner: the chosen sidebar item is pressed in, as a held-down key, so it never reads as Compose's raised pill
    "--depth-nav": `inset 0 1px 2px var(--shadow-color), inset 0 0 0 1px ${mix("--shadow-color", 50)}, 0 1px ${mix("--highlight", 70)}`,
    "--emboss": `0 1px 0 ${mix("--highlight", 85)}`,
  },
};
