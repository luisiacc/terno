import { Apple } from "./icons";
import type { SiteCopy } from "../copy";

/**
 * The Mac download (→ the Worker's /download/mac: the newest stable DMG, or /download/ while none is published)
 * and the Windows/Linux waitlist link. Unstyled structure; the design passes classes.
 */
export function DownloadMac({ copy, className = "", subClassName = "" }: { copy: SiteCopy; className?: string; subClassName?: string }) {
  return (
    <a href="/download/mac" className={className} data-download="mac">
      <Apple size="1.15em" />
      <span className="flex flex-col items-start leading-tight">
        <span>{copy.download.mac}</span>
        <span className={subClassName}>{copy.download.macSub}</span>
      </span>
    </a>
  );
}

export function WaitlistLink({ copy, className = "" }: { copy: SiteCopy; className?: string }) {
  return (
    <a href="#waitlist" className={className}>
      {copy.download.other} · {copy.download.otherSub}
    </a>
  );
}
