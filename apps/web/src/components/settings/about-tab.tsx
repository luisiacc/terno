import { t } from "@terno/i18n";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Button } from "@terno/ui/components/button";
import { ExternalLink, RotateCw } from "@terno/ui/icons";
import { BUILD } from "~/lib/diag";
import { openLink } from "~/lib/open-link";
import { releaseNotesUrl, TERNO_LINKS } from "~/lib/terno-links";
import { useHasUpdates, useUpdates } from "~/lib/updates";
import { useWeb } from "~/web/lifecycle";
import { SettingsGroup } from "./parts";
import { UpdatePrefsGroup, UpdateStatusRow } from "./updates-section";

/** The first year Terno was published; the © line names it. */
const SINCE = "2026";

/** The leading column of the card's rows: the icon tile above, the status glyph below it, so the text starts on one line. */
const LEAD = "w-10 shrink-0";

/** "642c1b3", "642c1b3-dirty": the commit, short; none for a build that wasn't made from one. */
function shortSha(sha: string): string | null {
  if (!sha || sha === "dev") return null;
  return sha.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1");
}

/**
 * Plan 190: Settings → About. What this copy is (the version, selectable for a report), whether it is current and
 * what is pending, with the one action that matters; how updates come (desktop); where to read more.
 */
export function AboutTab() {
  const updater = useHasUpdates();
  const state = useUpdates((s) => s.state);
  const webUpdate = useWeb((s) => s.update);
  const sha = shortSha(BUILD.sha);
  const version = sha ? `${BUILD.version} (${sha})` : BUILD.version;
  return (
    <div data-testid="about-tab">
      <SettingsGroup testId="about-card">
        <div className="flex min-h-16 items-center gap-3 py-3">
          {/* the app's icon: the mark on the accent, as the Dock shows it, in this palette */}
          <span className={`${LEAD} flex size-10 items-center justify-center rounded-[22%] bg-primary text-primary-foreground shadow-xs`}>
            <TernoMark className="size-7" data-testid="about-mark" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight">Terno</h3>
            <p className="text-xs text-muted-foreground tabular-nums select-text" data-testid="about-version">
              {t("about.version", { version })}
            </p>
          </div>
        </div>
        {updater && state && <UpdateStatusRow state={state} lead={LEAD} />}
        {/* web: a newer deployment is installed and waiting (the sidebar's pill says it too) */}
        {!updater && webUpdate && (
          <div className="flex min-h-14 items-center gap-3 py-3" data-testid="about-web-update">
            <span className={`${LEAD} flex items-center justify-center self-start pt-0.5`}>
              <RotateCw aria-hidden className="size-4 text-primary" />
            </span>
            <div role="status" className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("about.status.webReady")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("about.status.webReadyHint")}</p>
            </div>
            <Button size="sm" onClick={() => webUpdate.apply()} data-testid="about-web-reload">
              {t("about.reload")}
            </Button>
          </div>
        )}
      </SettingsGroup>

      {updater && state && <UpdatePrefsGroup state={state} />}

      <footer className="mt-6 flex flex-col gap-2 px-1 text-xs text-muted-foreground" data-testid="about-footer">
        <nav aria-label={t("about.links")} className="flex flex-wrap gap-x-4 gap-y-1">
          <LinkButton href={releaseNotesUrl(BUILD.version, BUILD.sha)} testId="about-release-notes">
            {t("about.releaseNotes")}
          </LinkButton>
          <LinkButton href={TERNO_LINKS.source} testId="about-source">
            {t("about.source")}
          </LinkButton>
          <LinkButton href={TERNO_LINKS.license} testId="about-license">
            {t("about.license")}
          </LinkButton>
        </nav>
        <p data-testid="about-legal">{t("about.legal", { year: SINCE })}</p>
      </footer>
    </div>
  );
}

/** A page on GitHub, in the browser: the glyph says it leaves Terno. */
function LinkButton({ href, testId, children }: { href: string; testId: string; children: React.ReactNode }) {
  return (
    <Button variant="link-secondary" className="text-xs" onClick={() => openLink(href)} data-testid={testId}>
      {children}
      <ExternalLink data-icon="inline-end" aria-hidden className="text-muted-foreground" />
    </Button>
  );
}
