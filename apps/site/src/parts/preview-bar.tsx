import type { SiteCopy } from "../copy";
import { DESIGN_NAMES, DESIGNS, type SiteDesign } from "../site";

/** On /designs/<id>/ only: a small bar to switch between the candidates. Goes away with the previews. */
export function PreviewBar({ current, copy }: { current: SiteDesign; copy: SiteCopy }) {
  return (
    <nav aria-label={copy.preview.label} className="site-preview-bar">
      <span className="site-preview-label">{copy.preview.label}</span>
      {DESIGNS.map((d, i) => (
        <a key={d} href={`/designs/${d}/`} aria-current={d === current ? "page" : undefined}>
          {i + 1}. {DESIGN_NAMES[d]}
        </a>
      ))}
    </nav>
  );
}
