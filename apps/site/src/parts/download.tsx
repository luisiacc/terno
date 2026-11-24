import type { SiteCopy } from "../copy";
import { pathIn } from "../site";
import { Apple, Terminal } from "./icons";

/** where the header's Download takes you: the hero's buttons, so you choose your computer (plan 254) */
export const DOWNLOAD_ANCHOR = "download";

/**
 * The Mac download (→ the Worker's /download/mac: the latest release's DMG; with none, /download/ in the visitor's
 * language). Unstyled structure; the design passes classes.
 */
export function DownloadMac({ copy, className = "", subClassName = "" }: { copy: SiteCopy; className?: string; subClassName?: string }) {
  return (
    <a href={copy.lang === "es" ? "/download/mac?lang=es" : "/download/mac"} className={className}>
      <Apple size="1.15em" />
      <span className="flex flex-col items-start leading-tight">
        <span>{copy.download.mac}</span>
        <span className={subClassName}>{copy.download.macSub}</span>
      </span>
    </a>
  );
}

/** The Linux packages: a page, since there are four (.deb and .rpm, x86-64 and arm64) and you choose yours there. */
export function DownloadLinux({ copy, className = "", subClassName = "" }: { copy: SiteCopy; className?: string; subClassName?: string }) {
  return (
    <a href={pathIn(copy.lang === "es" ? "es" : "en", "linux")} className={className}>
      <Terminal size="1.15em" />
      <span className="flex flex-col items-start leading-tight">
        <span>{copy.download.linux}</span>
        <span className={subClassName}>{copy.download.linuxSub}</span>
      </span>
    </a>
  );
}

/** The Windows waitlist, on the same page. */
export function WaitlistLink({ copy, className = "" }: { copy: SiteCopy; className?: string }) {
  return (
    <a href="#waitlist" className={className}>
      {copy.download.other} · {copy.download.otherSub}
    </a>
  );
}
