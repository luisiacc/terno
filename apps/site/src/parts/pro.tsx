import type { SiteCopy } from "../copy";
import { Shot, type ShotName } from "./shot";

/**
 * Terno Pro's section (plan 97), shared by the three designs: which features it shows and with which picture, and
 * the two picture frames. Each design lays them out and colors them its own way; the geometry is in styles.css.
 */

type ProFeature = Exclude<keyof SiteCopy["pro"], "eyebrow" | "status" | "title" | "body" | "price" | "privacy" | "ownKey">;

/** the lead, shown large */
export const PRO_LEAD = { id: "reply", shot: "ai-reply" } as const satisfies { id: ProFeature; shot: ShotName };
/** the other four, shown smaller, in this order */
export const PRO_MORE = [
  { id: "ask", shot: "ai-ask" },
  { id: "today", shot: "ai-today" },
  { id: "digest", shot: "ai-digest" },
  { id: "summaries", shot: "ai-summary" },
] as const satisfies readonly { id: ProFeature; shot: ShotName }[];

/** the privacy page's AI section, named by its own title so both languages say what the link opens */
export function proPrivacyLink(copy: SiteCopy) {
  const page = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const ai = copy.pages.privacy.sections.find((s) => s.id === "ai")!;
  return { href: `${page}#ai`, label: `${copy.nav.privacy} · ${ai.title}` };
}

/** The lead picture, whole; on a phone, cropped to the reading pane so the drafted reply stays legible. */
export function ProLeadShot({ copy, sizes }: { copy: SiteCopy; sizes: string }) {
  return (
    <div className="site-pro-lead">
      <Shot name={PRO_LEAD.shot} copy={copy} sizes={sizes} />
    </div>
  );
}

/**
 * A smaller picture as a window peeking up into a stage, cut off by the stage's bottom edge. Every picture is shown
 * at the same scale (its frame's width follows the picture's), so the four read as one set. `className` styles the
 * stage, `frameClassName` the window.
 */
export function Peek({ name, copy, sizes, className = "", frameClassName = "" }: { name: ShotName; copy: SiteCopy; sizes: string; className?: string; frameClassName?: string }) {
  return (
    <div className={`site-peek ${className}`}>
      <div className={`site-peek-frame site-peek-${name} ${frameClassName}`}>
        <Shot name={name} copy={copy} sizes={sizes} />
      </div>
    </div>
  );
}
