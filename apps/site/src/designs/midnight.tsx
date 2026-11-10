import type { ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { Check, ChevronRight, Github, Languages, Mails } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { PRO_LEAD, PRO_MORE, Peek, ProLeadShot, proPrivacyLink } from "../parts/pro";
import { DESIGN_SHOTS, Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LANGUAGES, LICENSE_URL, pathIn, type Route } from "../site";
import type { HomeDesign } from "./types";

/**
 * Midnight (plan 97, design 3): dark first, keyboard first. Keycaps are the visual language; Geist for text, Geist
 * Mono for numbers and keys. A crisp white/zinc variant follows the system when it is light.
 */

type FeatureId = keyof SiteCopy["features"];
type Feature = Pick<SiteCopy["features"][FeatureId], "title" | "body" | "points">;

const wrap = "mx-auto w-full max-w-6xl px-5 sm:px-8";
const mono = "font-mono text-[0.72rem] uppercase tracking-[0.14em]";
const link = "rounded-md text-(--mn-muted) transition-colors duration-100 hover:text-(--mn-fg)";

/**
 * The header's language menu: a disclosure (complete without the script, which only adds Esc and a click outside to
 * close it) listing every language by its own name, the current one checked.
 */
function LanguageMenu({ copy, route }: { copy: SiteCopy; route: Route }) {
  const page = route.page === "404" ? "home" : route.page;
  return (
    <details data-menu className="mn-menu relative">
      <summary aria-label={copy.nav.languageMenu} title={copy.nav.languageMenu} className="mn-iconbtn">
        <Languages size={16} />
      </summary>
      <ul className="mn-menu-list absolute top-full right-0 mt-2 min-w-40 p-1">
        {LANGUAGES.map(({ lang, name }) => {
          const current = lang === copy.lang;
          return (
            <li key={lang}>
              <a href={pathIn(lang, page)} lang={lang} hrefLang={lang} aria-current={current ? "page" : undefined} className="mn-menu-item">
                {name}
                {current && <Check size={16} className="text-(--mn-accent)" />}
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** A key as a keycap; `big` is the closing section's. */
function Cap({ k, big }: { k: string; big?: boolean }) {
  return <Kbd className={big ? "mn-cap mn-cap-big" : "mn-cap"}>{k}</Kbd>;
}

/** One part of the app (the list, a snackbar, ⌘K), from its own section picture (`<part>-detail`), shown whole. */
function Section({ name, copy, sizes, className = "mt-auto" }: { name: ShotName; copy: SiteCopy; sizes: string; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-(--mn-line) bg-(--mn-shot) ${className}`}>
      <Shot name={name} copy={copy} sizes={sizes} className="block h-auto w-full" />
    </div>
  );
}

function Card({ f, className = "", children }: { f: Feature; className?: string; children?: ReactNode }) {
  return (
    <article className={`mn-card flex flex-col gap-8 bg-(--mn-bg) p-6 sm:p-8 ${className}`}>
      <div>
        <h3 className="mt-4 text-xl font-semibold tracking-tight text-balance text-(--mn-fg) sm:text-2xl">{f.title}</h3>
        <p className="mt-3 max-w-prose leading-relaxed text-pretty text-(--mn-muted)">{f.body}</p>
        {f.points.length > 0 && (
          <ul className="mt-5 grid gap-2 font-mono text-[0.8rem] text-(--mn-muted)">
            {f.points.map((p) => (
              <li key={p} className="flex items-start gap-2.5">
                <Check size="1.15em" className="mt-px shrink-0 text-(--mn-accent)" />
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </article>
  );
}

/**
 * Terno Pro (plan 97), its own section after the features: the header with a "Coming soon" chip and the planned
 * price, the same hairline grid as the features with the drafted reply across it and the other four two by two,
 * then what AI sends and the own-key note. Violet marks it as Pro, as quietly as the blue marks the rest.
 */
function Pro({ copy }: { copy: SiteCopy }) {
  const p = copy.pro;
  const privacyAi = proPrivacyLink(copy);
  return (
    <section id="pro" className={`${wrap} mt-28 scroll-mt-20 sm:mt-36`} aria-labelledby="mn-pro">
      <div className="max-w-2xl">
        <p className="flex flex-wrap items-center gap-3">
          <span className={`${mono} mn-pro-mark`}>{p.eyebrow}</span>
          <span className={`${mono} mn-pro-chip rounded-full px-2.5 py-1 text-[0.66rem] leading-none`}>{p.status}</span>
        </p>
        <h2 id="mn-pro" className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
          {p.title}
        </h2>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-pretty text-(--mn-muted)">{p.body}</p>
        <p className="mt-4 font-mono text-[0.78rem] leading-relaxed text-(--mn-dim)">{p.price}</p>
      </div>

      <div className="mn-grid mt-12 grid gap-px overflow-hidden rounded-2xl border border-(--mn-line) bg-(--mn-line) md:grid-cols-2">
        <Card f={p[PRO_LEAD.id]} className="md:col-span-2">
          <div className="relative mt-2">
            <div className="mn-glow mn-pro-glow" aria-hidden="true" />
            <div className="relative overflow-hidden rounded-xl border border-(--mn-line) bg-(--mn-shot)">
              <ProLeadShot copy={copy} sizes="(min-width: 1200px) 1024px, (min-width: 640px) 90vw, 200vw" />
            </div>
          </div>
        </Card>
        {PRO_MORE.map(({ id, shot }) => (
          <Card key={id} f={p[id]}>
            <Peek name={shot} copy={copy} sizes="(min-width: 768px) 440px, 84vw" className="mn-pro-stage mt-auto rounded-xl border border-(--mn-line) pt-[6%]" frameClassName="mn-pro-frame" />
          </Card>
        ))}
      </div>

      <div className="mt-10 max-w-3xl">
        <p className="text-[1.05rem] leading-relaxed text-pretty text-(--mn-fg)">{p.privacy}</p>
        <p className="mt-3 text-sm leading-relaxed text-pretty text-(--mn-dim)">
          {p.ownKey}{" "}
          <a href={privacyAi.href} className="inline-flex items-center gap-0.5 rounded-md whitespace-nowrap text-(--mn-muted) underline decoration-(--mn-line) underline-offset-4 transition-colors duration-100 hover:text-(--mn-fg) hover:decoration-(--mn-muted)">
            {privacyAi.label}
            <ChevronRight size="1.15em" />
          </a>
        </p>
      </div>
    </section>
  );
}

export const Midnight: HomeDesign = ({ copy, route }) => {
  const f = copy.features;
  const privacy = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const home = copy.lang === "es" ? "/es/" : "/";
  // the hero's keys: ⌘K, E, L, /
  const half = "(min-width: 1024px) 512px, (min-width: 768px) 45vw, 90vw";
  // a wide section keeps 470px on a phone (site-wide)
  const halfWide = "(min-width: 1024px) 512px, (min-width: 768px) 45vw, (min-width: 640px) 90vw, 470px";

  return (
    <div className="mn min-h-dvh bg-(--mn-bg) font-geist text-(--mn-fg)">
      <header className="mn-header sticky top-0 z-40 border-b border-(--mn-line)">
        {/* inside the banner so axe's every-content-in-a-landmark holds */}
        <a href="#main" className="site-skip">
          {copy.skip}
        </a>
        <div className={`${wrap} flex h-14 items-center justify-between gap-4`}>
          <a href={home} className="flex items-center gap-2.5 rounded-md font-semibold tracking-tight" aria-label={copy.nav.home}>
            <Logo size={24} />
            <span aria-hidden="true">Terno</span>
          </a>
          <div className="flex items-center gap-5">
            <nav aria-label={copy.nav.home} className="flex items-center gap-5 text-sm max-sm:hidden">
              <a href="#features" className={link}>
                {copy.nav.features}
              </a>
              <a href="#pro" className={link}>
                {copy.nav.pro}
              </a>
              <a href={privacy} className={link}>
                {copy.nav.privacy}
              </a>
            </nav>
            <div className="flex items-center gap-1">
              <a href={GITHUB} aria-label={copy.nav.sourceOnGithub} title={copy.nav.sourceOnGithub} className="mn-iconbtn">
                <Github size={16} />
              </a>
              <LanguageMenu copy={copy} route={route} />
              <a href="/download/mac" className="mn-btn mn-btn-primary ml-2 h-8 px-3 text-[0.8rem]">
                {copy.nav.download}
              </a>
            </div>
          </div>
        </div>
      </header>

      <main id="main">
        {/* hero */}
        <section className="mn-hero relative overflow-hidden">
          <div className={`${wrap} relative pt-20 text-center sm:pt-28`}>
            <h1 className="mx-auto mt-7 max-w-4xl text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-7xl">
              <span className="mn-title">{copy.hero.title}</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-balance text-(--mn-muted)">{copy.hero.subtitle}</p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <DownloadMac copy={copy} className="mn-btn mn-btn-primary h-12 gap-2.5 px-5 text-[0.95rem]" subClassName="text-[0.7rem] font-normal text-white" />
              <WaitlistLink copy={copy} className="mn-btn mn-btn-ghost h-12 px-5 text-[0.9rem]" />
            </div>
            <p className={`${mono} mt-5 text-(--mn-dim) normal-case tracking-[0.04em]`}>{copy.hero.note}</p>

          </div>

          <div className={`${wrap} relative mt-14 pb-16 sm:mt-16`}>
            <div className="mn-glow" aria-hidden="true" />
            <Window className="mn-window relative rounded-xl">
              <Shot name="inbox" copy={copy} eager sizes="(min-width: 1200px) 1088px, 94vw" />
            </Window>
          </div>
        </section>

        {/* stats, as a command line */}
        <section className={`${wrap} mt-4 sm:mt-12`}>
          <ul className="mn-term grid overflow-hidden rounded-2xl border border-(--mn-line) bg-(--mn-raised) sm:grid-cols-3">
            {copy.stats.map((s) => (
              <li key={s.value} className="flex flex-col gap-2 border-(--mn-line) px-6 py-6 not-first:border-t sm:px-8 sm:py-8 sm:not-first:border-t-0 sm:not-first:border-l">
                <span className="font-mono text-3xl font-medium tracking-tight whitespace-nowrap text-(--mn-fg) sm:text-4xl">
                  <span className="mn-prompt" aria-hidden="true">
                    ›
                  </span>
                  {s.value}
                </span>
                <span className="text-sm leading-snug text-(--mn-muted)">{s.label}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* features */}
        <section id="features" className={`${wrap} mt-28 scroll-mt-20 sm:mt-36`} aria-labelledby="mn-features">
          {/* the section's heading for screen readers (the cards are h3); no visible label above the grid */}
          <h2 id="mn-features" className="sr-only">
            {copy.nav.features}
          </h2>
          <div className="mn-grid grid gap-px overflow-hidden rounded-2xl border border-(--mn-line) bg-(--mn-line) md:grid-cols-2 lg:grid-cols-6">
            <Card f={f.unified} className="md:col-span-2 lg:col-span-4">
              <Section name="unified-detail" copy={copy} sizes="(min-width: 1024px) 700px, (min-width: 640px) 90vw, 470px" className="site-wide site-wide-end mt-auto" />
            </Card>
            <Card f={f.local} className="md:col-span-2 lg:col-span-2">
              <div className="mn-local mt-auto flex items-center justify-between gap-3 rounded-xl border border-(--mn-line) bg-(--mn-raised) px-5 py-6" aria-hidden="true">
                <span className="mn-node">
                  <Logo size={28} />
                </span>
                <span className="mn-wire" />
                <span className="mn-node">
                  <Mails size={18} />
                </span>
              </div>
            </Card>
            <Card f={f.search} className="lg:col-span-3">
              <Section name="search-detail" copy={copy} sizes={half} />
            </Card>
            <Card f={f.triage} className="lg:col-span-3">
              <Section name="triage-detail" copy={copy} sizes={half} />
            </Card>
            <Card f={f.palette} className="lg:col-span-3">
              <Section name="palette-detail" copy={copy} sizes={halfWide} className="site-wide mt-auto" />
            </Card>
            <Card f={f.snippets} className="lg:col-span-3">
              <Section name="snippets-detail" copy={copy} sizes={halfWide} className="site-wide mt-auto" />
            </Card>
            <Card f={f.codes} className="lg:col-span-2">
              <Section name="code-detail" copy={copy} sizes="(min-width: 1024px) 320px, (min-width: 768px) 45vw, 90vw" />
            </Card>
            <Card f={f.speed} className="lg:col-span-2" />
            <Card f={f.open} className="md:col-span-2 lg:col-span-2">
              <a href={GITHUB} className="mn-btn mn-btn-ghost mt-auto h-10 gap-2 self-start px-4 text-sm">
                <Github size="1.15em" />
                {f.open.cta}
                <ChevronRight size="1.15em" className="text-(--mn-dim)" />
              </a>
            </Card>
            <Card f={f.themes} className="md:col-span-2 lg:col-span-6">
              {/* the five designs, named, above the palettes; on a phone Lumen across, the others two by two */}
              <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-5">
                {DESIGN_SHOTS.map(([design, s], i) => (
                  <li key={s} className={i === 0 ? "max-sm:col-span-2" : ""}>
                    <figure>
                      <div className="mn-thumb relative overflow-hidden rounded-lg border border-(--mn-line)">
                        <Shot name={s} copy={copy} sizes={`(min-width: 1024px) 200px, (min-width: 640px) 18vw, ${i === 0 ? "90vw" : "45vw"}`} />
                      </div>
                      <figcaption className="mt-2.5 font-mono text-[0.75rem] text-(--mn-muted)">{copy.designs[design]}</figcaption>
                    </figure>
                  </li>
                ))}
              </ul>
              <div className="-mt-5 grid grid-cols-3 gap-3 sm:grid-cols-5">
                {(["palette-dracula", "palette-nord", "palette-gruvbox", "palette-solarized", "palette-catppuccin"] as const).map((s) => (
                  <div key={s} className="mn-thumb relative overflow-hidden rounded-md border border-(--mn-line)">
                    <Shot name={s} copy={copy} sizes="(min-width: 1024px) 200px, 30vw" />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </section>

        <Pro copy={copy} />

        {/* keyboard: the cheat sheet */}
        <section className={`${wrap} mt-28 sm:mt-36`} aria-labelledby="mn-keyboard">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <h2 id="mn-keyboard" className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
                {f.keyboard.title}
              </h2>
              <p className="mt-5 max-w-md text-lg leading-relaxed text-pretty text-(--mn-muted)">{f.keyboard.body}</p>
              <dl className="mn-sheet mt-10 grid gap-px overflow-hidden rounded-xl border border-(--mn-line) bg-(--mn-line) sm:grid-cols-2">
                {copy.keys.map((k) => (
                  <div key={k.label} className="flex items-center justify-between gap-4 bg-(--mn-bg) px-4 py-3">
                    <dt className="text-sm text-(--mn-muted)">{k.label}</dt>
                    <dd className="flex shrink-0 gap-1.5">
                      {k.keys.map((key) => (
                        <Cap key={key} k={key} />
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="relative hidden sm:block">
              <div className="mn-glow mn-glow-soft" aria-hidden="true" />
              <Section name="shortcuts-detail" copy={copy} sizes="(min-width: 1024px) 640px, 55vw" className="shadow-2xl" />
            </div>
          </div>
        </section>

        {/* closing and the waitlist */}
        <section className={`${wrap} mt-28 sm:mt-36`} aria-labelledby="mn-closing">
          <div className="mn-closing relative overflow-hidden rounded-3xl border border-(--mn-line) px-6 py-16 text-center sm:px-12 sm:py-24">
            <div className="flex justify-center gap-2.5" aria-hidden="true">
              <Cap k="⌘" big />
              <Cap k="N" big />
            </div>
            <h2 id="mn-closing" className="mx-auto mt-10 max-w-2xl text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-6xl">
              {copy.closing.title}
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-lg text-pretty text-(--mn-muted)">{copy.closing.body}</p>
            <div className="mt-9 flex justify-center">
              <DownloadMac copy={copy} className="mn-btn mn-btn-primary h-12 gap-2.5 px-5 text-[0.95rem]" subClassName="text-[0.7rem] font-normal text-white" />
            </div>
          </div>
        </section>

        <section id="waitlist" className={`${wrap} mt-6 scroll-mt-20`} aria-labelledby="mn-waitlist">
          <div className="grid gap-10 rounded-3xl border border-(--mn-line) bg-(--mn-raised) px-6 py-10 sm:px-12 sm:py-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <h2 id="mn-waitlist" className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                {copy.waitlist.title}
              </h2>
              <p className="mt-3 leading-relaxed text-pretty text-(--mn-muted)">{copy.waitlist.body}</p>
            </div>
            <Waitlist
              copy={copy}
              c={{
                form: "grid gap-4 sm:grid-cols-[1fr_11rem] sm:items-end",
                label: `${mono} text-[0.68rem] text-(--mn-muted)`,
                input: "mn-field h-11 rounded-lg px-3.5 text-base",
                select: "mn-field h-11 rounded-lg px-3 text-base",
                button: "mn-btn mn-btn-primary h-11 px-5 text-[0.9rem] sm:col-span-2 sm:justify-self-start",
                note: "text-sm text-(--mn-dim) sm:col-span-2",
                status: "text-sm sm:col-span-2",
              }}
            />
          </div>
        </section>
      </main>

      <footer className={`${wrap} mt-24 border-t border-(--mn-line) py-10 pb-28`}>
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Logo size={22} />
            <span className="font-semibold tracking-tight">Terno</span>
            <span className="text-sm text-(--mn-dim)">{copy.footer.tagline}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[0.78rem]">
            <a href={privacy} className={link}>
              {copy.footer.privacy}
            </a>
            <a href={GITHUB} className={link}>
              {copy.footer.source}
            </a>
            <a href={LICENSE_URL} className={link}>
              {copy.footer.license}
            </a>
            <a href={copy.nav.languageHref} className={link} lang={copy.lang === "en" ? "es" : "en"}>
              {copy.nav.language}
            </a>
            <span className="text-(--mn-dim)">{copy.footer.copyright}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
