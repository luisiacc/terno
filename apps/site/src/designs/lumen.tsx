import type { ComponentType, ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { Archive, Check, Command, ExternalLink, Github, KeyRound, Keyboard, Mails, NotepadText, Palette, Search, ShieldCheck, Zap } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LICENSE_URL } from "../site";
import type { HomeDesign } from "./types";

/**
 * Lumen (plan 96, design 1): the app's own default design as a website. Warm paper, Figtree, the brand blue used
 * sparingly, one large product shot under a centered headline, then features alternating text and shots.
 */

type Feature = SiteCopy["features"][keyof SiteCopy["features"]];
type Icon = ComponentType<{ size?: number | string; className?: string }>;

const wrap = "mx-auto w-full max-w-6xl px-6 sm:px-8";
const h2 = "text-[2rem] leading-[1.1] font-semibold tracking-[-0.025em] text-balance sm:text-[2.6rem]";
const lead = "text-lg leading-relaxed text-(--l-muted) text-pretty";
const card = "lumen-card overflow-hidden rounded-2xl";
/** a soft tinted stage that a detail sits on, like a product photo */
const stage = "lumen-stage rounded-3xl p-3 sm:p-10";

function Kicker({ icon: I, children }: { icon?: Icon; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[0.95rem] font-medium text-(--l-accent)">
      {I && <I size="1.15em" />}
      {children}
    </p>
  );
}

function Points({ points }: { points: readonly string[] }) {
  if (!points.length) return null;
  return (
    <ul className="mt-7 grid gap-3 border-t border-(--l-line) pt-6">
      {points.map((p) => (
        <li key={p} className="flex items-start gap-3 text-[0.98rem] text-(--l-fg)">
          <Check size="1.15em" className="mt-[0.2em] shrink-0 text-(--l-accent)" />
          {p}
        </li>
      ))}
    </ul>
  );
}

/** A feature: text on one side, its picture on the other; `flip` puts the picture first on wide screens. */
function Row({ id, f, icon, flip, children }: { id: string; f: Feature; icon: Icon; flip?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`${wrap} grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-12 lg:gap-16`}>
      <div className={`lg:col-span-5 ${flip ? "lg:order-2 lg:col-start-8" : ""}`}>
        <Kicker icon={icon}>{f.kicker}</Kicker>
        <h2 id={`${id}-title`} className={`mt-4 ${h2}`}>
          {f.title}
        </h2>
        <p className={`mt-5 ${lead}`}>{f.body}</p>
        <Points points={f.points} />
      </div>
      <div className={`lg:col-span-7 ${flip ? "lg:order-1 lg:col-start-1" : ""}`}>{children}</div>
    </section>
  );
}

/** A full screenshot in a macOS window. */
function Framed({ name, copy }: { name: ShotName; copy: SiteCopy }) {
  return (
    <Window className="lumen-window rounded-xl">
      <Shot name={name} copy={copy} sizes="(min-width: 1024px) 680px, 92vw" />
    </Window>
  );
}

/** A detail of a screenshot (the list column, a snackbar, the code chip); lumen.css holds each crop's geometry. */
function Crop({ name, copy, crop, className = "" }: { name: ShotName; copy: SiteCopy; crop: string; className?: string }) {
  return (
    <div className={`lumen-crop lumen-crop-${crop} ${className}`}>
      <Shot name={name} copy={copy} sizes="(min-width: 1024px) 1800px, 300vw" />
    </div>
  );
}

const PALETTES = [
  ["palette-dracula", "Dracula"],
  ["palette-nord", "Nord"],
  ["palette-solarized", "Solarized"],
  ["palette-catppuccin", "Catppuccin"],
  ["palette-gruvbox", "Gruvbox"],
] as const;

export const Lumen: HomeDesign = ({ copy }) => {
  const f = copy.features;
  const privacy = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const otherLang = copy.lang === "es" ? "en" : "es";
  return (
    <div className="lumen min-h-dvh font-figtree text-(--l-fg)">
      <a href="#main" className="site-skip">
        {copy.skip}
      </a>

      <header className={`${wrap} flex h-20 items-center justify-between gap-6`}>
        <a href={copy.lang === "es" ? "/es/" : "/"} aria-label={copy.nav.home} className="flex items-center gap-2.5 text-[1.05rem] font-semibold tracking-tight">
          <Logo size={28} />
          <span aria-hidden="true">Terno</span>
        </a>
        <nav className="flex items-center gap-1 text-[0.95rem]">
          <a href="#features" className="lumen-navlink max-sm:hidden">
            {copy.nav.features}
          </a>
          <a href={privacy} className="lumen-navlink max-sm:hidden">
            {copy.nav.privacy}
          </a>
          <a href={GITHUB} className="lumen-navlink max-sm:hidden">
            {copy.nav.source}
          </a>
          <a href={copy.nav.languageHref} hrefLang={otherLang} lang={otherLang} className="lumen-navlink">
            {copy.nav.language}
          </a>
          <a href="/download/mac" data-download="mac" className="lumen-btn ml-2 h-9 rounded-full px-4 text-[0.9rem]">
            {copy.nav.download}
          </a>
        </nav>
      </header>

      <main id="main">
        {/* hero */}
        <section className="lumen-hero overflow-hidden pt-10 sm:pt-16" aria-labelledby="hero-title">
          <div className={`${wrap} flex flex-col items-center text-center`}>
            <p className="lumen-pill inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium">
              <Logo size={16} />
              {copy.hero.eyebrow}
            </p>
            <h1 id="hero-title" className="mt-7 max-w-4xl text-[2.9rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[5.25rem]">
              {copy.hero.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-(--l-muted) text-pretty sm:text-xl">{copy.hero.subtitle}</p>
            <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
              <DownloadMac copy={copy} className="lumen-btn h-14 gap-3 rounded-2xl pr-6 pl-5 text-[1.05rem]" subClassName="text-[0.78rem] font-normal" />
              <WaitlistLink copy={copy} className="lumen-quietlink text-[0.98rem]" />
            </div>
            <p className="mt-6 text-sm text-(--l-muted)">{copy.hero.note}</p>
          </div>
          {/* on a phone the window runs off the right edge, so the list stays legible */}
          <div className="mx-auto mt-14 w-full max-w-[76rem] px-4 max-sm:w-[190%] max-sm:max-w-none max-sm:pr-0 sm:mt-16 sm:px-8">
            <Window className="lumen-window lumen-window-hero rounded-[14px] sm:rounded-2xl">
              <Shot name="inbox" copy={copy} eager sizes="(min-width: 1280px) 1150px, (min-width: 640px) 96vw, 190vw" />
            </Window>
          </div>
        </section>

        {/* speed, in numbers */}
        <section aria-labelledby="speed-title" className={`${wrap} pt-28 pb-12 text-center sm:pt-36`}>
          <div className="flex justify-center">
            <Kicker icon={Zap}>{f.speed.kicker}</Kicker>
          </div>
          <h2 id="speed-title" className={`mx-auto mt-4 max-w-3xl ${h2}`}>
            {f.speed.title}
          </h2>
          <p className={`mx-auto mt-5 max-w-2xl ${lead}`}>{f.speed.body}</p>
          <dl className="mt-16 grid gap-10 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-(--l-line)">
            {copy.stats.map((s) => (
              <div key={s.label} className="flex flex-col-reverse items-center gap-2 px-6">
                <dt className="max-w-[16rem] text-[0.95rem] text-(--l-muted) text-balance">{s.label}</dt>
                <dd className="text-5xl font-semibold tracking-[-0.03em] text-(--l-fg) sm:text-6xl">{s.value}</dd>
              </div>
            ))}
          </dl>
          <ul className="mx-auto mt-14 flex max-w-3xl flex-wrap justify-center gap-x-8 gap-y-3 text-[0.95rem] text-(--l-muted)">
            {f.speed.points.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <Check size="1.15em" className="text-(--l-accent)" />
                {p}
              </li>
            ))}
          </ul>
        </section>

        <div id="features">
          <Row id="unified" f={f.unified} icon={Mails}>
            <div className={`${card}`}>
              <Crop name="inbox" copy={copy} crop="unified" />
            </div>
          </Row>

          <Row id="search" f={f.search} icon={Search} flip>
            <Framed name="search" copy={copy} />
          </Row>

          <Row id="triage" f={f.triage} icon={Archive}>
            <div className={`${stage} grid gap-5`}>
              <div className={`${card} sm:mr-10`}>
                <Crop name="file-similar" copy={copy} crop="file" />
              </div>
              <div className={`${card} sm:ml-10`}>
                <Crop name="archive-similar" copy={copy} crop="archive" />
              </div>
            </div>
          </Row>

          <Row id="codes" f={f.codes} icon={KeyRound} flip>
            <div className={`${card} relative`}>
              <Crop name="code" copy={copy} crop="code" />
              <span className="lumen-ring" aria-hidden="true" />
            </div>
          </Row>
        </div>

        {/* local: a calm statement, no picture needed */}
        <section id="local" aria-labelledby="local-title" className="lumen-band py-24 sm:py-32">
          <div className={`${wrap} text-center`}>
            <span className="lumen-badge mx-auto flex size-14 items-center justify-center rounded-2xl" aria-hidden="true">
              <ShieldCheck size={28} />
            </span>
            <div className="mt-6 flex justify-center">
              <Kicker>{f.local.kicker}</Kicker>
            </div>
            <h2 id="local-title" className={`mx-auto mt-4 max-w-3xl ${h2}`}>
              {f.local.title}
            </h2>
            <p className={`mx-auto mt-5 max-w-2xl ${lead}`}>{f.local.body}</p>
            <ul className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
              {f.local.points.map((p) => (
                <li key={p} className="lumen-tile flex items-center gap-3 rounded-2xl px-5 py-4 text-left text-[0.98rem]">
                  <Check size="1.15em" className="shrink-0 text-(--l-accent)" />
                  {p}
                </li>
              ))}
            </ul>
            <p className="mt-10">
              <a href={privacy} className="lumen-link text-[0.98rem]">
                {copy.nav.privacy}
              </a>
            </p>
          </div>
        </section>

        <Row id="palette" f={f.palette} icon={Command}>
          <div className={stage}>
            <div className={card}>
              <Crop name="palette" copy={copy} crop="palette" />
            </div>
          </div>
        </Row>

        <Row id="snippets" f={f.snippets} icon={NotepadText} flip>
          <div className={stage}>
            <div className={card}>
              <Crop name="snippets" copy={copy} crop="overlay" />
            </div>
          </div>
        </Row>

        {/* keyboard */}
        <section id="keyboard" aria-labelledby="keyboard-title" className="lumen-band py-24 sm:py-32">
          <div className={wrap}>
            <div className="mx-auto max-w-3xl text-center">
              <div className="flex justify-center">
                <Kicker icon={Keyboard}>{f.keyboard.kicker}</Kicker>
              </div>
              <h2 id="keyboard-title" className={`mt-4 ${h2}`}>
                {f.keyboard.title}
              </h2>
              <p className={`mx-auto mt-5 max-w-2xl ${lead}`}>{f.keyboard.body}</p>
            </div>
            <ul className="mx-auto mt-14 grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-4">
              {copy.keys.map((k) => (
                <li key={k.label} className="lumen-tile flex flex-col items-start gap-4 rounded-2xl p-5">
                  <span className="flex gap-1.5">
                    {k.keys.map((key) => (
                      <Kbd key={key} className="lumen-key">
                        {key}
                      </Kbd>
                    ))}
                  </span>
                  <span className="text-[0.95rem] text-(--l-muted)">{k.label}</span>
                </li>
              ))}
            </ul>
            <div className="mx-auto mt-16 max-w-4xl">
              <Window className="lumen-window rounded-xl">
                <Shot name="shortcuts" copy={copy} sizes="(min-width: 1024px) 1024px, 92vw" />
              </Window>
            </div>
          </div>
        </section>

        {/* themes */}
        <section id="themes" aria-labelledby="themes-title" className="py-24 sm:py-32">
          <div className={wrap}>
            <div className="mx-auto max-w-3xl text-center">
              <div className="flex justify-center">
                <Kicker icon={Palette}>{f.themes.kicker}</Kicker>
              </div>
              <h2 id="themes-title" className={`mt-4 ${h2}`}>
                {f.themes.title}
              </h2>
              <p className={`mx-auto mt-5 max-w-2xl ${lead}`}>{f.themes.body}</p>
            </div>
            <div className="mt-14 grid gap-6 md:grid-cols-2">
              {(
                [
                  ["inbox-macos", "macOS"],
                  ["inbox-atelier", "Atelier"],
                ] as const
              ).map(([name, label]) => (
                <figure key={name}>
                  <Window className="lumen-window rounded-xl">
                    <Shot name={name} copy={copy} sizes="(min-width: 768px) 560px, 92vw" />
                  </Window>
                  <figcaption className="mt-3 text-center text-sm font-medium text-(--l-muted)">{label}</figcaption>
                </figure>
              ))}
            </div>
            <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {PALETTES.map(([name, label], i) => (
                <li key={name} className={i === PALETTES.length - 1 ? "max-sm:col-span-2 max-sm:mx-auto max-sm:w-1/2" : ""}>
                  <figure>
                    <div className="lumen-thumb overflow-hidden rounded-lg">
                      <Shot name={name} copy={copy} sizes="(min-width: 1024px) 220px, 46vw" />
                    </div>
                    <figcaption className="mt-2.5 text-center text-sm text-(--l-muted)">{label}</figcaption>
                  </figure>
                </li>
              ))}
            </ul>
            <ul className="mx-auto mt-12 flex max-w-3xl flex-wrap justify-center gap-x-8 gap-y-3 text-[0.95rem] text-(--l-muted)">
              {f.themes.points.map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <Check size="1.15em" className="text-(--l-accent)" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* source available */}
        <section id="open" aria-labelledby="open-title" className={`${wrap} pb-24 sm:pb-32`}>
          <div className="lumen-panel flex flex-col items-start gap-8 rounded-3xl p-8 sm:p-12 lg:flex-row lg:items-center lg:justify-between lg:gap-16">
            <div className="max-w-2xl">
              <Kicker icon={Github}>{f.open.kicker}</Kicker>
              <h2 id="open-title" className={`mt-4 ${h2}`}>
                {f.open.title}
              </h2>
              <p className={`mt-5 ${lead}`}>{f.open.body}</p>
            </div>
            <a href={GITHUB} className="lumen-btn-quiet min-h-12 shrink-0 gap-2.5 rounded-full px-6 py-2.5 text-[0.98rem]">
              <Github size="1.15em" />
              {f.open.cta}
              <ExternalLink size="1em" className="opacity-60" />
            </a>
          </div>
        </section>

        {/* closing */}
        <section aria-labelledby="closing-title" className={`${wrap} pb-24 text-center sm:pb-32`}>
          <Logo size={56} className="mx-auto" />
          <h2 id="closing-title" className={`mx-auto mt-8 max-w-3xl ${h2} sm:text-5xl`}>
            {copy.closing.title}
          </h2>
          <p className={`mx-auto mt-5 max-w-xl ${lead}`}>{copy.closing.body}</p>
          <div className="mt-10 flex justify-center">
            <DownloadMac copy={copy} className="lumen-btn h-14 gap-3 rounded-2xl pr-6 pl-5 text-[1.05rem]" subClassName="text-[0.78rem] font-normal" />
          </div>
        </section>

        {/* Windows and Linux */}
        <section id="waitlist" aria-labelledby="waitlist-title" className="lumen-band py-24 sm:py-28">
          <div className={`${wrap} grid gap-10 lg:grid-cols-12 lg:gap-16`}>
            <div className="lg:col-span-5">
              <h2 id="waitlist-title" className={h2}>
                {copy.waitlist.title}
              </h2>
              <p className={`mt-5 ${lead}`}>{copy.waitlist.body}</p>
            </div>
            <div className="lg:col-span-7">
              <Waitlist
                copy={copy}
                c={{
                  form: "grid gap-4 sm:grid-cols-[1fr_11rem] sm:items-end",
                  label: "text-sm font-medium",
                  input: "lumen-field h-12 rounded-xl px-4 text-base",
                  select: "lumen-field h-12 rounded-xl px-3.5 text-base",
                  button: "lumen-btn h-12 rounded-xl px-6 text-[0.98rem] sm:col-span-2 sm:justify-self-start",
                  note: "text-sm text-(--l-muted) sm:col-span-2",
                  status: "text-[0.98rem] font-medium sm:col-span-2",
                }}
              />
            </div>
          </div>
        </section>
      </main>

      <footer className={`${wrap} flex flex-col gap-8 py-12 text-sm text-(--l-muted) sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex items-center gap-3">
          <Logo size={22} />
          <span>{copy.footer.tagline}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href={privacy} className="lumen-footlink">
            {copy.footer.privacy}
          </a>
          <a href={GITHUB} className="lumen-footlink">
            {copy.footer.source}
          </a>
          <a href={LICENSE_URL} className="lumen-footlink">
            {copy.footer.license}
          </a>
          <a href={copy.nav.languageHref} hrefLang={otherLang} lang={otherLang} className="lumen-footlink">
            {copy.nav.language}
          </a>
          <span>{copy.footer.copyright}</span>
        </div>
      </footer>
    </div>
  );
};
