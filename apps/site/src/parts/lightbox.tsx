import type { SiteCopy } from "../copy";
import { X } from "./icons";

/** The enlarged screenshot (client.ts fills and opens it): a modal <dialog>, so Esc, focus and the backdrop are the browser's. */
export function Lightbox({ copy }: { copy: SiteCopy }) {
  return (
    <dialog className="site-lightbox" aria-label={copy.shot.enlarge} data-lightbox>
      <button type="button" className="site-lightbox-close" data-close autoFocus>
        <X size={20} aria-label={copy.shot.close} role="img" />
      </button>
      <img alt="" data-lightbox-img />
    </dialog>
  );
}
