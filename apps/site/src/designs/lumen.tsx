import type { ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { Check, ChevronRight, ExternalLink, Github, ShieldCheck } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { PRO_LEAD, PRO_MORE, Peek, ProLeadShot, proPrivacyLink } from "../parts/pro";
import { Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LICENSE_URL } from "../site";
import type { HomeDesign } from "./types";

/**
 * Lumen (plan 97, design 1): the app's own default design as a website. Warm paper, Figtree, the brand blue used
 * sparingly, one large product shot under a centered headline, then features alternating text and shots.
 */

type Feature = SiteCopy["features"][keyof SiteCopy["features"]];

const wrap = "mx-auto w-full max-w-6xl px-6 sm:px-8";
const h2 = "text-[2rem] leading-[1.1] font-semibold tracking-[-0.025em] text-balance sm:text-[2.6rem]";
const h3 = "text-[1.3rem] leading-[1.2] font-semibold tracking-[-0.02em] text-balance sm:text-[1.45rem]";
const lead = "text-lg leading-relaxed text-(--l-muted) text-pretty";
const card = "lumen-card overflow-hidden rounded-2xl";
/** a soft tinted stage that a detail sits on, like a product photo */
const stage = "lumen-stage rounded-3xl p-3 sm:p-10";

function Points({ points, className = "mt-7" }: { points: readonly string[]; className?: string }) {
  if (!points.length) return null;
  return (
    <ul className={`grid gap-3 border-t border-(--l-line) pt-6 ${className}`}>
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
function Row({ id, f, flip, children }: { id: string; f: Feature; flip?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`${wrap} grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-12 lg:gap-16`}>
      <div className={`lg:col-span-5 ${flip ? "lg:order-2 lg:col-start-8" : ""}`}>
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

/** One part of the app (the list, a snackbar, ⌘K), from its own section picture (`<part>-detail`), shown whole. */
function Section({ name, copy, wide = "" }: { name: ShotName; copy: SiteCopy; wide?: string }) {
  return (
    <div className={`relative ${wide}`}>
      <Shot name={name} copy={copy} sizes="(min-width: 1024px) 620px, 92vw" className="block h-auto w-full" />
    </div>
  );
}

/**
 * Terno Pro (plan 97), right after the privacy band so the promise comes first: the header with its "Coming soon"
 * chip and the planned price, the drafted reply large, the other four as tiles with their pictures peeking up from
 * the bottom, then what AI sends and the own-key note. A quiet violet marks it as Pro; no button, it isn't for sale yet.
 */
function Pro({ copy }: { copy: SiteCopy }) {
  const p = copy.pro;
  const reply = p[PRO_LEAD.id];
  const privacyAi = proPrivacyLink(copy);
  return (
    <section id="pro" aria-labelledby="pro-title" className="py-24 sm:py-32">
      <div className={wrap}>
        <div className="mx-auto max-w-3xl text-center">
          <p className="flex items-center justify-center gap-3 text-[0.95rem] font-semibold">
            <span className="lumen-pro-mark">{p.eyebrow}</span>
            <span className="lumen-pro-chip rounded-full px-2.5 py-1 text-[0.78rem] leading-none font-medium">{p.status}</span>
          </p>
          <h2 id="pro-title" className={`mt-5 ${h2}`}>
            {p.title}
          </h2>
          <p className={`mx-auto mt-5 max-w-2xl ${lead}`}>{p.body}</p>
          <p className="mt-5 text-sm text-(--l-muted)">{p.price}</p>
        </div>

        <div className="mx-auto mt-14 max-w-5xl">
          <Window className="lumen-window site-pro-lead-window rounded-xl">
            <ProLeadShot copy={copy} sizes="(min-width: 1024px) 1024px, (min-width: 640px) 92vw, 200vw" />
          </Window>
          <div className="mt-12 grid gap-8 lg:grid-cols-2 lg:gap-16">
            <div>
              <h3 className={`${h3} sm:text-[1.75rem]`}>{reply.title}</h3>
              <p className={`mt-4 ${lead}`}>{reply.body}</p>
            </div>
            <Points points={reply.points} className="lg:mt-1.5" />
          </div>
        </div>

        <ul className="mx-auto mt-16 grid max-w-5xl gap-6 md:grid-cols-2">
          {PRO_MORE.map(({ id, shot }) => (
            <li key={id} className="lumen-tile lumen-pro-tile flex flex-col overflow-hidden rounded-2xl">
              <div className="p-7 sm:p-8">
                <h3 className={h3}>{p[id].title}</h3>
                <p className="mt-3 text-[0.98rem] leading-relaxed text-pretty text-(--l-muted)">{p[id].body}</p>
                <Points points={p[id].points} className="mt-5 pt-5" />
              </div>
              <Peek name={shot} copy={copy} sizes="(min-width: 768px) 470px, 88vw" className="mt-auto" frameClassName="lumen-pro-frame" />
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-16 max-w-2xl text-center">
          <p className="text-[1.05rem] leading-relaxed text-pretty">{p.privacy}</p>
          <p className="mt-4 text-sm leading-relaxed text-pretty text-(--l-muted)">
            {p.ownKey}{" "}
            <a href={privacyAi.href} className="lumen-link inline-flex items-center gap-0.5 whitespace-nowrap">
              {privacyAi.label}
              <ChevronRight size="1.15em" />
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

const PALETTES = [
  ["palette-dracula", "Apple · Dracula"],
  ["palette-nord", "Terno · Nord"],
  ["palette-solarized", "Solarized · Tokyo Night"],
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
          <a href="#pro" className="lumen-navlink max-sm:hidden">
            {copy.nav.pro}
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
            <h1 id="hero-title" className="mt-7 max-w-4xl text-[2.9rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[5.25rem]">
              {copy.hero.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-(--l-muted) text-balance sm:text-xl">{copy.hero.subtitle}</p>
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
          <Row id="unified" f={f.unified}>
            <div className={`${card}`}>
              <Section name="unified-detail" copy={copy} wide="site-wide site-wide-end" />
            </div>
          </Row>

          <Row id="search" f={f.search} flip>
            <Framed name="search" copy={copy} />
          </Row>

          <Row id="triage" f={f.triage}>
            <div className={`${stage} grid gap-5`}>
              <div className={`${card} sm:mr-10`}>
                <Section name="triage-detail" copy={copy} />
              </div>
              <div className={`${card} sm:ml-10`}>
                <Section name="archive-detail" copy={copy} />
              </div>
            </div>
          </Row>

          <Row id="codes" f={f.codes} flip>
            <div className={card}>
              <Section name="code-detail" copy={copy} />
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

        <Pro copy={copy} />

        <Row id="palette" f={f.palette}>
          <div className={stage}>
            <div className={card}>
              <Section name="palette-detail" copy={copy} wide="site-wide" />
            </div>
          </div>
        </Row>

        <Row id="snippets" f={f.snippets} flip>
          <div className={stage}>
            <div className={card}>
              <Section name="snippets-detail" copy={copy} wide="site-wide" />
            </div>
          </div>
        </Row>

        {/* keyboard */}
        <section id="keyboard" aria-labelledby="keyboard-title" className="lumen-band py-24 sm:py-32">
          <div className={wrap}>
            <div className="mx-auto max-w-3xl text-center">
              <div className="flex justify-center">
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
                    <div className="lumen-thumb relative overflow-hidden rounded-lg">
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
