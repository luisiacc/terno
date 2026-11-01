import type { ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { Check, ChevronRight, Github, Lock, Zap } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LICENSE_URL } from "../site";
import type { HomeDesign } from "./types";

/**
 * Bento (plan 96, design 4): an Apple-keynote grid. A crisp hero over the product, then one dense grid of rounded
 * tiles, each a feature with a cropped detail of a shot. Areas and crops live in bento.css and the class strings
 * below; the grid's DOM order is the reading order, so one column on a phone reads the same.
 */

type FeatureId = keyof SiteCopy["features"];
type Stat = SiteCopy["stats"][number];

const tile = "flex flex-col overflow-hidden rounded-[28px] bg-(--b-tile) ring-1 ring-(--b-line) ring-inset";
const pad = "p-7 sm:p-8";
const kicker = "text-[13px] font-semibold tracking-[-0.005em] text-(--b-accent)";
const muted = "text-(--b-muted)";

function Tile({ area, className = "", children }: { area: string; className?: string; children: ReactNode }) {
  return (
    <div data-area={area} className={`${tile} ${className}`}>
      {children}
    </div>
  );
}

function Text({ copy, id, big, points }: { copy: SiteCopy; id: FeatureId; big?: boolean; points?: boolean }) {
  const f = copy.features[id];
  return (
    <div className={pad}>
      <p className={kicker}>{f.kicker}</p>
      <h3 className={`mt-1.5 font-semibold text-balance ${big ? "text-[28px] leading-[1.08] tracking-[-0.025em] sm:text-[34px]" : "text-[24px] leading-[1.12] tracking-[-0.022em]"}`}>{f.title}</h3>
      <p className={`mt-3 max-w-[34rem] text-[15px] leading-[1.55] text-pretty ${muted}`}>{f.body}</p>
      {points && f.points.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[14px]">
          {f.points.map((p) => (
            <li key={p} className="flex items-center gap-1.5">
              <Check size="1.15em" className="text-(--b-accent)" />
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A detail of a shot: a frame rising from the tile's bottom edge; `img` positions and scales the 1440×900 shot. */
function Crop({ copy, name, frame, img }: { copy: SiteCopy; name: ShotName; frame: string; img: string }) {
  return (
    <div className={`bento-crop mx-5 mt-auto sm:mx-7 ${frame}`}>
      <Shot name={name} copy={copy} sizes="1440px" className={img} />
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className={`${pad} flex h-full flex-col justify-end`}>
      <p className="text-[64px] leading-none font-semibold tracking-[-0.045em] tabular-nums sm:text-[76px]">{value}</p>
      <p className={`mt-3 max-w-[14rem] text-[15px] leading-snug ${muted}`}>{label}</p>
    </div>
  );
}

const keycap = "bento-key inline-flex h-12 min-w-12 items-center justify-center rounded-[11px] bg-(--b-key) px-3 font-system text-[19px] font-medium";

export const Bento: HomeDesign = ({ copy }) => {
  const f = copy.features;
  const privacy = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const navLink = `rounded-full px-3 py-1.5 text-[14px] ${muted} hover:text-(--b-fg)`;
  const primary = "inline-flex items-center gap-2.5 rounded-full bg-(--b-invert-bg) py-3 pr-6 pl-5 text-left text-[15px] font-medium text-(--b-invert-fg) hover:opacity-90";
  const [ms, zero, seventeen] = copy.stats as [Stat, Stat, Stat];
  return (
    <div className="min-h-dvh bg-(--b-page) font-system text-(--b-fg)">
      <a href="#main" className="site-skip">
        {copy.skip}
      </a>

      <header className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-5 sm:px-8">
        <a href={copy.lang === "es" ? "/es/" : "/"} aria-label={copy.nav.home} className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em]">
          <Logo size={26} />
          <span aria-hidden="true">Terno</span>
        </a>
        <nav aria-label="Terno" className="flex items-center gap-1">
          <a href="#features" className={`${navLink} max-sm:hidden`}>
            {copy.nav.features}
          </a>
          <a href={privacy} className={`${navLink} max-sm:hidden`}>
            {copy.nav.privacy}
          </a>
          <a href={GITHUB} className={`${navLink} max-sm:hidden`}>
            {copy.nav.source}
          </a>
          <a href={copy.nav.languageHref} lang={copy.lang === "es" ? "en" : "es"} className={navLink}>
            {copy.nav.language}
          </a>
          <a href="/download/mac" className="ml-1 rounded-full bg-(--b-invert-bg) px-4 py-1.5 text-[14px] font-medium text-(--b-invert-fg) hover:opacity-90">
            {copy.nav.download}
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto max-w-[1200px] px-5 pt-14 text-center sm:px-8 sm:pt-20">
          <p className="text-[15px] font-semibold text-(--b-accent)">{copy.hero.eyebrow}</p>
          <h1 className="mx-auto mt-3 max-w-[14ch] text-[48px] leading-[1.02] font-semibold tracking-[-0.032em] text-balance sm:text-[80px]">{copy.hero.title}</h1>
          <p className={`mx-auto mt-6 max-w-[38rem] text-[19px] leading-[1.45] text-pretty sm:text-[21px] ${muted}`}>{copy.hero.subtitle}</p>
          <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-6">
            <DownloadMac copy={copy} className={primary} subClassName="text-[12px] font-normal opacity-70" />
            <WaitlistLink copy={copy} className="text-[15px] font-medium text-(--b-accent) hover:underline hover:underline-offset-4" />
          </div>
          <p className={`mt-5 text-[13px] ${muted}`}>{copy.hero.note}</p>
          <div className="mt-14 sm:mt-20">
            <Window className="bento-window">
              <Shot name="inbox" copy={copy} eager sizes="(min-width: 1200px) 1136px, 100vw" />
            </Window>
          </div>
        </section>

        <section id="features" aria-labelledby="features-title" className="mx-auto max-w-[1200px] scroll-mt-6 px-5 pt-24 sm:px-8 sm:pt-32">
          <h2 id="features-title" className="sr-only">
            {copy.nav.features}
          </h2>
          <div className="bento-grid">
            <Tile area="unified">
              <Text copy={copy} id="unified" big points />
              <Crop copy={copy} name="inbox" frame="aspect-[4/3] min-[1080px]:aspect-auto min-[1080px]:min-h-[300px] min-[1080px]:flex-1" img="left-0 top-0 w-[225%] -translate-y-[12.5%]" />
            </Tile>

            <Tile area="search">
              <Text copy={copy} id="search" />
              <Crop copy={copy} name="search" frame="aspect-[3/1] min-[1080px]:aspect-auto min-[1080px]:min-h-[150px] min-[1080px]:flex-1" img="left-0 top-0 w-[370%] -translate-x-[17.6%] -translate-y-[1.2%]" />
            </Tile>

            <Tile area="local" className="justify-between">
              <div className={pad}>
                <span className="flex size-12 items-center justify-center rounded-full bg-(--b-accent)/12 text-(--b-accent)">
                  <Lock size={24} />
                </span>
                <p className={`mt-6 ${kicker}`}>{f.local.kicker}</p>
                <h3 className="mt-1.5 text-[24px] leading-[1.12] font-semibold tracking-[-0.022em] text-balance">{f.local.title}</h3>
                <p className={`mt-3 text-[15px] leading-[1.55] text-pretty ${muted}`}>{f.local.body}</p>
              </div>
            </Tile>

            <Tile area="zero">
              <StatTile value={zero.value} label={zero.label} />
            </Tile>

            <Tile area="codes">
              <Text copy={copy} id="codes" />
              <Crop copy={copy} name="code" frame="aspect-[3.3/1] min-[1080px]:aspect-auto min-[1080px]:min-h-[150px] min-[1080px]:flex-1" img="left-1/2 top-1/2 w-[390%] -translate-x-[31.4%] -translate-y-[19.8%]" />
            </Tile>

            <Tile area="triage">
              <Text copy={copy} id="triage" big points />
              <Crop copy={copy} name="file-similar" frame="aspect-[5/4] min-[1080px]:aspect-auto min-[1080px]:min-h-[280px] min-[1080px]:flex-1" img="left-0 bottom-0 w-[360%] -translate-x-[17.4%]" />
            </Tile>

            <Tile area="speed">
              <div className={pad}>
                <span className="flex size-12 items-center justify-center rounded-full bg-(--b-accent)/12 text-(--b-accent)">
                  <Zap size={24} />
                </span>
                <p className={`mt-6 ${kicker}`}>{f.speed.kicker}</p>
                <h3 className="mt-1.5 text-[24px] leading-[1.12] font-semibold tracking-[-0.022em] text-balance">{f.speed.title}</h3>
                <p className={`mt-3 text-[15px] leading-[1.55] text-pretty ${muted}`}>{f.speed.body}</p>
              </div>
            </Tile>

            <Tile area="ms">
              <StatTile value={ms.value} label={ms.label} />
            </Tile>

            <Tile area="palette">
              <Text copy={copy} id="palette" />
              <Crop copy={copy} name="palette" frame="aspect-[16/10] min-[1080px]:aspect-auto min-[1080px]:min-h-[230px] min-[1080px]:flex-1" img="left-1/2 top-1/2 w-[170%] -translate-x-1/2 -translate-y-[32.5%]" />
            </Tile>

            <Tile area="snippets">
              <Text copy={copy} id="snippets" />
              <Crop copy={copy} name="snippets" frame="aspect-[16/10] min-[1080px]:aspect-auto min-[1080px]:min-h-[230px] min-[1080px]:flex-1" img="left-1/2 top-1/2 w-[170%] -translate-x-1/2 -translate-y-[33.5%]" />
            </Tile>

            <Tile area="keyboard">
              <Text copy={copy} id="keyboard" />
              <ul className={`${pad} mt-auto grid grid-cols-2 gap-x-4 gap-y-5 pt-0 sm:grid-cols-4`}>
                {copy.keys.map((k) => (
                  <li key={k.label} className="flex flex-col items-start gap-2">
                    <span className="flex gap-1.5">
                      {k.keys.map((key) => (
                        <Kbd key={key} className={keycap}>
                          {key}
                        </Kbd>
                      ))}
                    </span>
                    <span className={`text-[13px] leading-snug ${muted}`}>{k.label}</span>
                  </li>
                ))}
              </ul>
            </Tile>

            <Tile area="themes">
              <Text copy={copy} id="themes" big />
              <div className={`${pad} mt-auto grid grid-cols-2 gap-3 pt-0`}>
                {(["palette-dracula", "palette-solarized", "palette-nord", "palette-catppuccin", "palette-gruvbox"] as const).map((name, i) => (
                  <div key={name} className={`bento-thumb ${i === 0 ? "col-span-2" : ""}`}>
                    <Shot name={name} copy={copy} sizes={i === 0 ? "(min-width: 1080px) 960px, 170vw" : "(min-width: 1080px) 480px, 85vw"} />
                  </div>
                ))}
              </div>
            </Tile>

            <Tile area="open">
              <div className={`${pad} flex h-full flex-col`}>
                <span className="flex size-12 items-center justify-center rounded-full bg-(--b-fg) text-(--b-tile)">
                  <Github size={24} />
                </span>
                <p className={`mt-6 ${kicker}`}>{f.open.kicker}</p>
                <h3 className="mt-1.5 text-[24px] leading-[1.12] font-semibold tracking-[-0.022em] text-balance">{f.open.title}</h3>
                <p className={`mt-3 text-[15px] leading-[1.55] text-pretty ${muted}`}>{f.open.body}</p>
                <a href={GITHUB} className="mt-5 self-start text-[15px] font-medium text-(--b-accent) hover:underline hover:underline-offset-4">
                  {f.open.cta}
                  <ChevronRight size="1.15em" className="bento-arrow ml-0.5 inline align-[-0.22em]" />
                </a>
              </div>
            </Tile>

            <Tile area="seventeen">
              <StatTile value={seventeen.value} label={seventeen.label} />
            </Tile>
          </div>
        </section>

        <section aria-labelledby="closing-title" className="mx-auto max-w-[1200px] px-5 pt-4 sm:px-8">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={`${tile} items-center justify-center px-7 py-14 text-center sm:px-10 sm:py-16`}>
              <Logo size={64} />
              <h2 id="closing-title" className="mt-7 text-[34px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[44px]">
                {copy.closing.title}
              </h2>
              <p className={`mt-4 max-w-[26rem] text-[17px] leading-[1.5] text-pretty ${muted}`}>{copy.closing.body}</p>
              <DownloadMac copy={copy} className={`${primary} mt-8`} subClassName="text-[12px] font-normal opacity-70" />
            </div>
            <section id="waitlist" aria-labelledby="waitlist-title" className={`${tile} scroll-mt-6 px-7 py-14 sm:px-10 sm:py-16`}>
              <h2 id="waitlist-title" className="text-[28px] leading-[1.1] font-semibold tracking-[-0.03em] text-balance sm:text-[32px]">
                {copy.waitlist.title}
              </h2>
              <p className={`mt-3 text-[15px] leading-[1.55] text-pretty ${muted}`}>{copy.waitlist.body}</p>
              <Waitlist
                copy={copy}
                c={{
                  form: "mt-8 grid gap-4 sm:grid-cols-[1fr_9.5rem] sm:items-end",
                  label: "text-[13px] font-medium",
                  input: "h-11 rounded-xl border border-(--b-line-strong) bg-(--b-page) px-3.5 text-[15px] placeholder:text-(--b-muted)",
                  select: "h-11 rounded-xl border border-(--b-line-strong) bg-(--b-page) px-3 text-[15px]",
                  button: "h-11 rounded-full bg-(--b-accent) px-6 text-[15px] font-medium text-white dark:text-[#0b1230] hover:opacity-90 sm:col-span-2 sm:justify-self-start",
                  note: `text-[13px] leading-snug sm:col-span-2 ${muted}`,
                  status: "text-[14px] sm:col-span-2",
                }}
              />
            </section>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-[1200px] px-5 pt-16 pb-24 sm:px-8">
        <div className="flex flex-col gap-6 border-t border-(--b-line-strong) pt-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Logo size={22} />
            <p className={`text-[13px] ${muted}`}>{copy.footer.tagline}</p>
          </div>
          <nav aria-label={copy.footer.tagline} className={`flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] ${muted}`}>
            <a href={privacy} className="hover:text-(--b-fg)">
              {copy.footer.privacy}
            </a>
            <a href={GITHUB} className="hover:text-(--b-fg)">
              {copy.footer.source}
            </a>
            <a href={LICENSE_URL} className="hover:text-(--b-fg)">
              {copy.footer.license}
            </a>
            <a href={copy.nav.languageHref} lang={copy.lang === "es" ? "en" : "es"} className="hover:text-(--b-fg)">
              {copy.nav.language}
            </a>
            <span>{copy.footer.copyright}</span>
          </nav>
        </div>
      </footer>
    </div>
  );
};
