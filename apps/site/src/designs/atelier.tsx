import type { ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { ArrowDown, Github, HardDrive, Lock, ShieldCheck } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LICENSE_URL } from "../site";
import type { HomeDesign } from "./types";

/**
 * Atelier (plan 96): an editorial home page, like a printed magazine or a type specimen. Instrument Serif display on
 * paper and ink, hairline rules for structure, numbered sections, screenshots set as captioned plates.
 */

type FeatureId = keyof SiteCopy["features"];
const ORDER: FeatureId[] = ["unified", "local", "search", "speed", "triage", "codes", "themes", "snippets", "palette", "keyboard", "open"];
const num = (id: FeatureId) => String(ORDER.indexOf(id) + 1).padStart(2, "0");

/** The display titles' italic: the last phrase after a stop or comma, else the closing word (two when it is short). */
function Emph({ text, stack }: { text: string; stack?: boolean }) {
  if (stack) {
    // one sentence a line on wide screens, the last in italic
    const lines = text.split(/(?<=\.) /);
    return (
      <>
        {lines.map((l, i) => (
          <span key={l} className="lg:block">
            {i === lines.length - 1 ? <em className="atl-em">{l}</em> : `${l} `}
          </span>
        ))}
      </>
    );
  }
  const cut = Math.max(text.lastIndexOf(". ", text.length - 2), text.lastIndexOf(", "));
  let at = cut >= 0 ? cut + 2 : text.lastIndexOf(" ") + 1;
  if (cut < 0 && text.length - at <= 4) at = text.lastIndexOf(" ", at - 2) + 1;
  return (
    <>
      {text.slice(0, at)}
      <em className="atl-em">{text.slice(at)}</em>
    </>
  );
}

const kickerCls = "font-geist text-[0.6875rem] font-medium uppercase tracking-[0.2em] text-(--a-muted)";

function Kicker({ id, copy }: { id: FeatureId; copy: SiteCopy }) {
  return (
    <p className={`flex items-center gap-3 ${kickerCls}`}>
      <span className="font-serif text-[1.35rem] leading-none tracking-normal text-(--a-accent) normal-case italic">{num(id)}</span>
      <span aria-hidden="true" className="h-px w-7 bg-(--a-rule-strong)" />
      <span>{copy.features[id].kicker}</span>
    </p>
  );
}

function Title({ id, copy, className = "" }: { id: FeatureId; copy: SiteCopy; className?: string }) {
  return (
    <h2 id={`${id}-title`} className={`mt-5 font-serif text-[clamp(2.4rem,4.6vw,4.1rem)] leading-[1.02] tracking-[-0.012em] text-balance ${className}`}>
      <Emph text={copy.features[id].title} />
    </h2>
  );
}

const bodyCls = "mt-5 max-w-[34rem] font-geist text-[1.0625rem] leading-[1.7] text-(--a-muted) text-pretty";

function Body({ id, copy, className = "" }: { id: FeatureId; copy: SiteCopy; className?: string }) {
  return <p className={`${bodyCls} ${className}`}>{copy.features[id].body}</p>;
}

/** points as an index: hairline rows, a small numeral each */
function Points({ id, copy, row, className = "" }: { id: FeatureId; copy: SiteCopy; row?: boolean; className?: string }) {
  const points = copy.features[id].points;
  if (!points.length) return null;
  if (row)
    return (
      <ul className={`mt-12 grid border-t border-(--a-rule-strong) font-geist text-[0.9375rem] md:grid-cols-3 ${className}`}>
        {points.map((p, i) => (
          <li key={p} className={`flex gap-4 py-5 md:px-6 ${i === 0 ? "md:pl-0" : "border-t border-(--a-rule) md:border-t-0 md:border-l"}`}>
            <span aria-hidden="true" className="font-serif text-base text-(--a-accent) italic">
              {String.fromCharCode(97 + i)}.
            </span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <ul className={`mt-8 border-t border-(--a-rule) font-geist text-[0.9375rem] ${className}`}>
      {points.map((p, i) => (
        <li key={p} className="flex gap-4 border-b border-(--a-rule) py-3">
          <span aria-hidden="true" className="w-5 shrink-0 font-serif text-base text-(--a-accent) italic">
            {String.fromCharCode(97 + i)}.
          </span>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ id, className = "", children }: { id: FeatureId; className?: string; children: ReactNode }) {
  return (
    <section id={`f-${id}`} aria-labelledby={`${id}-title`} className={`atl-section ${className}`}>
      {children}
    </section>
  );
}

/** a screenshot set like a printed plate: on a mat, hairline edge, its section's number and kicker below */
function Plate({ name, copy, caption, sizes, crop, className = "" }: { name: ShotName; copy: SiteCopy; caption: ReactNode; sizes: string; crop?: { box: string; img: string }; className?: string }) {
  return (
    <figure className={`m-0 ${className}`}>
      <div className="atl-mat">
        {crop ? (
          <div className={`relative overflow-hidden ${crop.box}`}>
            <Shot name={name} copy={copy} sizes={sizes} className={`absolute h-auto max-w-none ${crop.img}`} />
          </div>
        ) : (
          <Shot name={name} copy={copy} sizes={sizes} className="block h-auto w-full" />
        )}
      </div>
      <figcaption className={`mt-3 flex items-baseline gap-3 ${kickerCls}`}>{caption}</figcaption>
    </figure>
  );
}

const Cap = ({ n, children }: { n: string; children: ReactNode }) => (
  <>
    <span className="font-mono text-[0.6875rem] tracking-normal text-(--a-accent)">{n}</span>
    <span>{children}</span>
  </>
);

const btnPrimary =
  "atl-press inline-flex items-center gap-3 rounded-[3px] bg-(--a-ink) px-5 py-3 font-geist text-[0.9375rem] font-medium text-(--a-paper) hover:bg-(--a-accent-strong)";
const linkQuiet = "atl-link font-geist text-[0.9375rem] text-(--a-ink)";

export const Atelier: HomeDesign = ({ copy }) => {
  const f = copy.features;
  const privacy = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  return (
    <div className="atl min-h-dvh font-geist">
      {/* masthead; the skip link sits in it so it belongs to a landmark */}
      <header className="atl-wrap pt-6 md:pt-8">
        <a href="#main" className="site-skip">
          {copy.skip}
        </a>
        <div className="flex items-center justify-between gap-6 pb-4">
          <a href={copy.lang === "es" ? "/es/" : "/"} aria-label={copy.nav.home} className="flex items-center gap-2.5">
            <Logo size={26} />
            <span aria-hidden="true" className="font-serif text-[1.75rem] leading-none">
              Terno
            </span>
          </a>
          <nav aria-label="Terno" className="flex items-center gap-5 font-geist text-[0.875rem] md:gap-7">
            <a href="#contents" className="atl-nav hidden md:inline">
              {copy.nav.features}
            </a>
            <a href={privacy} className="atl-nav hidden md:inline">
              {copy.nav.privacy}
            </a>
            <a href={GITHUB} className="atl-nav hidden md:inline">
              {copy.nav.source}
            </a>
            <a href={copy.nav.languageHref} className="atl-nav" lang={copy.lang === "es" ? "en" : "es"}>
              {copy.nav.language}
            </a>
            <a href="/download/mac" className="atl-press rounded-[3px] border border-(--a-ink) px-3.5 py-1.5 font-medium hover:bg-(--a-ink) hover:text-(--a-paper)">
              {copy.nav.download}
            </a>
          </nav>
        </div>
        <div aria-hidden="true" className="atl-double" />
      </header>

      <main id="main">
        {/* hero */}
        <section aria-labelledby="hero-title" className="atl-wrap">
          <div className="grid gap-x-10 pt-12 md:pt-20 lg:grid-cols-12">
            <p className={`lg:col-span-12 ${kickerCls}`}>
              <span className="text-(--a-ink)">Terno</span>
              <span aria-hidden="true" className="mx-3 text-(--a-rule-strong)">
                /
              </span>
              {copy.hero.eyebrow}
            </p>
            <h1 id="hero-title" className="mt-6 font-serif text-[clamp(3.4rem,10.5vw,9.75rem)] leading-[0.9] tracking-[-0.025em] text-balance lg:col-span-11">
              <Emph text={copy.hero.title} />
            </h1>
            <ul className={`order-last mt-10 lg:order-none lg:col-span-3 lg:mt-14 lg:self-end ${kickerCls} tracking-[0.14em]`}>
              {copy.hero.note.split(" · ").map((n) => (
                <li key={n} className="border-t border-(--a-rule) py-2.5 last:border-b">
                  {n}
                </li>
              ))}
            </ul>
            <div className="mt-10 lg:col-span-5 lg:col-start-7 lg:mt-14">
              <p className="font-geist text-[1.1875rem] leading-[1.6] text-(--a-muted) text-pretty">{copy.hero.subtitle}</p>
              <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
                <DownloadMac copy={copy} className={btnPrimary} subClassName="text-[0.75rem] font-normal opacity-75" />
                <WaitlistLink copy={copy} className={linkQuiet} />
              </div>
            </div>
          </div>

          <figure className="m-0 mt-16 md:mt-24">
            <Window className="atl-hero-window">
              {/* on a phone, the sidebar and list at a readable size rather than the whole window in miniature */}
              <div className="relative max-sm:aspect-[625/780] max-sm:overflow-hidden">
                <Shot name="inbox-atelier" copy={copy} eager sizes="(min-width: 1360px) 1280px, (min-width: 640px) 94vw, 220vw" className="block h-auto w-full max-sm:absolute max-sm:top-0 max-sm:left-0 max-sm:w-[230.4%]! max-sm:max-w-none" />
              </div>
            </Window>
            <figcaption className={`mt-4 flex items-baseline justify-between gap-6 ${kickerCls}`}>
              <span className="flex items-baseline gap-3">
                <span className="font-mono text-[0.6875rem] tracking-normal text-(--a-accent)">00</span>
                <span>Terno · Atelier</span>
              </span>
              <a href="#contents" className="atl-nav hidden items-center gap-1.5 sm:inline-flex">
                {copy.nav.features}
                <ArrowDown size="1.15em" />
              </a>
            </figcaption>
          </figure>
        </section>

        {/* figures */}
        <div className="atl-wrap mt-24 md:mt-32">
          <dl className="grid border-y border-(--a-rule-strong) md:grid-cols-3">
            {copy.stats.map((s, i) => (
              <div key={s.label} className={`flex flex-col gap-3 py-8 md:px-8 md:py-10 ${i > 0 ? "border-t border-(--a-rule) md:border-t-0 md:border-l" : ""} ${i === 0 ? "md:pl-0" : ""}`}>
                <dt className="order-2 max-w-[16rem] font-geist text-[0.9375rem] leading-snug text-(--a-muted)">{s.label}</dt>
                <dd className="order-1 m-0 font-serif text-[clamp(3.5rem,6vw,5.25rem)] leading-none tracking-[-0.02em]">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* contents */}
        <nav id="contents" aria-labelledby="contents-title" className="atl-wrap mt-24 md:mt-32">
          <div className="grid gap-x-10 lg:grid-cols-12">
            <h2 id="contents-title" className="font-serif text-[2.5rem] leading-none italic lg:col-span-3">
              {copy.nav.features}
            </h2>
            <ol className="mt-8 gap-x-10 sm:columns-2 lg:col-span-9 lg:mt-1">
              {ORDER.map((id) => (
                <li key={id} className="break-inside-avoid border-t border-(--a-rule)">
                  <a href={`#f-${id}`} className="atl-toc group flex items-baseline gap-4 py-3">
                    <span className="w-6 font-mono text-[0.75rem] text-(--a-accent)">{num(id)}</span>
                    <span className="font-geist text-[0.9375rem]">{f[id].kicker}</span>
                    <span aria-hidden="true" className="atl-leader" />
                    <span className="hidden font-serif text-[1.05rem] text-(--a-muted) italic lg:inline">{f[id].title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        <div className="atl-wrap">
          {/* 01 unified */}
          <Section id="unified" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <Kicker id="unified" copy={copy} />
              <Title id="unified" copy={copy} />
              <Body id="unified" copy={copy} />
              <Points id="unified" copy={copy} />
            </div>
            <Plate
              name="inbox"
              copy={copy}
              caption={<Cap n="01">{f.unified.kicker}</Cap>}
              sizes="(min-width: 1024px) 66vw, 94vw"
              className="mt-12 lg:col-span-8 lg:mt-1"
            />
          </Section>

          {/* 02 local: typographic spread */}
          <Section id="local" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-12">
              <Kicker id="local" copy={copy} />
            </div>
            <h2 id="local-title" className="mt-6 font-serif text-[clamp(2.75rem,7vw,6.5rem)] leading-[0.96] tracking-[-0.02em] text-balance lg:col-span-7">
              <Emph text={f.local.title} stack />
            </h2>
            <p className={`${bodyCls} lg:col-span-4 lg:col-start-9 lg:mt-0 lg:self-end`}>{f.local.body}</p>
            <ul className="mt-12 grid border-t border-(--a-rule-strong) font-geist md:grid-cols-3 lg:col-span-12">
              {f.local.points.map((p, i) => {
                const Icon = [HardDrive, ShieldCheck, Lock][i] ?? Lock;
                return (
                  <li key={p} className={`flex items-center gap-3 py-5 text-[0.9375rem] md:px-6 ${i === 0 ? "md:pl-0" : "border-t border-(--a-rule) md:border-t-0 md:border-l"}`}>
                    <Icon size="1.15em" className="shrink-0 text-(--a-accent)" />
                    {p}
                  </li>
                );
              })}
            </ul>
          </Section>

          {/* 03 search */}
          <Section id="search" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <Kicker id="search" copy={copy} />
              <Title id="search" copy={copy} />
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:pt-12">
              <Body id="search" copy={copy} />
              <Points id="search" copy={copy} />
            </div>
            <Plate
              name="search"
              copy={copy}
              caption={<Cap n="03">{f.search.kicker}</Cap>}
              sizes="(min-width: 1360px) 1280px, 94vw"
              className="mt-14 lg:col-span-12"
            />
          </Section>

          {/* 04 speed: a pull quote */}
          <Section id="speed" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-12">
              <Kicker id="speed" copy={copy} />
            </div>
            <h2 id="speed-title" className="mt-6 font-serif text-[clamp(3.25rem,9vw,8rem)] leading-[0.92] tracking-[-0.025em] italic lg:col-span-6">
              {f.speed.title}
            </h2>
            <div className="lg:col-span-5 lg:col-start-8 lg:pt-6">
              <Body id="speed" copy={copy} />
              <Points id="speed" copy={copy} />
            </div>
          </Section>

          {/* 05 triage: two plates */}
          <Section id="triage" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <Kicker id="triage" copy={copy} />
              <Title id="triage" copy={copy} />
            </div>
            <div className="lg:col-span-6 lg:col-start-7 lg:pt-12">
              <Body id="triage" copy={copy} />
            </div>
            <div className="mt-14 grid gap-10 md:grid-cols-2 lg:col-span-12">
              <Plate
                name="file-similar"
                copy={copy}
                caption={<Cap n="05a">{f.triage.kicker}</Cap>}
                sizes="(min-width: 768px) 1800px, 1300px"
                crop={{ box: "aspect-[8/5]", img: "left-[-62%] top-[-260%] w-[360%]" }}
              />
              <Plate
                name="archive-similar"
                copy={copy}
                caption={<Cap n="05b">{f.triage.kicker}</Cap>}
                sizes="(min-width: 768px) 1800px, 1300px"
                crop={{ box: "aspect-[8/5]", img: "left-[-62%] top-[-260%] w-[360%]" }}
              />
            </div>
            <Points id="triage" copy={copy} row className="lg:col-span-12" />
          </Section>

          {/* 06 codes */}
          <Section id="codes" className="grid items-center gap-x-10 lg:grid-cols-12">
            <Plate
              name="code"
              copy={copy}
              caption={<Cap n="06">{f.codes.kicker}</Cap>}
              sizes="(min-width: 1024px) 2000px, 1400px"
              crop={{ box: "aspect-[5/2]", img: "left-[-62%] top-[-85%] w-[360%]" }}
              className="order-2 mt-12 lg:order-1 lg:col-span-7 lg:mt-0"
            />
            <div className="order-1 lg:order-2 lg:col-span-4 lg:col-start-9">
              <Kicker id="codes" copy={copy} />
              <Title id="codes" copy={copy} />
              <Body id="codes" copy={copy} />
            </div>
          </Section>

          {/* 07 themes: a contact sheet */}
          <Section id="themes" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <Kicker id="themes" copy={copy} />
              <Title id="themes" copy={copy} />
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:pt-12">
              <Body id="themes" copy={copy} />
            </div>
            <ul className="mt-14 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-3 lg:col-span-12 lg:gap-x-8">
              {(
                [
                  ["inbox-macos", "macOS"],
                  ["palette-solarized", "Solarized"],
                  ["palette-catppuccin", "Catppuccin Latte"],
                  ["palette-dracula", "Dracula"],
                  ["palette-nord", "Nord"],
                  ["palette-gruvbox", "Gruvbox"],
                ] as const
              ).map(([name, label], i) => (
                <li key={name}>
                  <Plate name={name} copy={copy} caption={<Cap n={`07.${i + 1}`}>{label}</Cap>} sizes="(min-width: 768px) 31vw, 47vw" />
                </li>
              ))}
            </ul>
            <Points id="themes" copy={copy} row className="lg:col-span-12" />
          </Section>

          {/* 08 snippets · 09 palette: a spread */}
          <div className="atl-spread grid gap-x-10 lg:grid-cols-2">
            {(["snippets", "palette"] as const).map((id) => (
              <Section key={id} id={id} className="atl-spread-page flex flex-col">
                <Kicker id={id} copy={copy} />
                <Title id={id} copy={copy} className="text-[clamp(2.2rem,3.6vw,3.25rem)]" />
                <Body id={id} copy={copy} />
                <Plate
                  name={id}
                  copy={copy}
                  caption={<Cap n={num(id)}>{f[id].kicker}</Cap>}
                  sizes="(min-width: 1024px) 1100px, 180vw"
                  crop={{ box: "aspect-[13/6]", img: "left-[-42.31%] top-[-33.33%] w-[184.62%]" }}
                  className="mt-auto pt-10"
                />
              </Section>
            ))}
          </div>

          {/* 10 keyboard: a specimen of keys */}
          <Section id="keyboard" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <Kicker id="keyboard" copy={copy} />
              <Title id="keyboard" copy={copy} />
              <Body id="keyboard" copy={copy} />
            </div>
            <dl className="mt-12 grid gap-x-10 sm:grid-cols-2 lg:col-span-6 lg:col-start-7 lg:mt-1">
              {copy.keys.map((k) => (
                <div key={k.label} className="flex items-center justify-between gap-4 border-t border-(--a-rule) py-3.5">
                  <dt className="font-geist text-[0.9375rem]">{k.label}</dt>
                  <dd className="m-0 flex gap-1.5">
                    {k.keys.map((key) => (
                      <Kbd key={key} className="atl-key">
                        {key}
                      </Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          {/* 11 open */}
          <Section id="open" className="grid gap-x-10 lg:grid-cols-12">
            <div className="lg:col-span-12">
              <Kicker id="open" copy={copy} />
            </div>
            <h2 id="open-title" className="mt-6 font-serif text-[clamp(2.75rem,7vw,6.5rem)] leading-[0.96] tracking-[-0.02em] text-balance lg:col-span-10">
              <Emph text={f.open.title} />
            </h2>
            <div className="lg:col-span-5 lg:col-start-8 lg:mt-6">
              <Body id="open" copy={copy} />
              <a href={GITHUB} className={`${btnPrimary} mt-8`}>
                <Github size="1.15em" />
                {f.open.cta}
              </a>
            </div>
          </Section>
        </div>

        {/* closing */}
        <section aria-labelledby="closing-title" className="atl-wrap mt-28 md:mt-40">
          <div aria-hidden="true" className="atl-double" />
          <div className="py-20 text-center md:py-28">
            <Logo size={44} className="mx-auto" />
            <h2 id="closing-title" className="mx-auto mt-8 max-w-[14ch] font-serif text-[clamp(3rem,8vw,7.5rem)] leading-[0.92] tracking-[-0.025em] text-balance">
              <Emph text={copy.closing.title} />
            </h2>
            <p className="mx-auto mt-7 max-w-[30rem] font-geist text-[1.125rem] leading-[1.6] text-(--a-muted) text-pretty">{copy.closing.body}</p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
              <DownloadMac copy={copy} className={btnPrimary} subClassName="text-[0.75rem] font-normal opacity-75" />
              <WaitlistLink copy={copy} className={linkQuiet} />
            </div>
          </div>
        </section>

        {/* waitlist */}
        <section id="waitlist" aria-labelledby="waitlist-title" className="atl-wrap">
          <div className="grid gap-x-10 border-t border-(--a-rule-strong) pt-10 pb-24 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h2 id="waitlist-title" className="font-serif text-[clamp(2.2rem,4vw,3.25rem)] leading-[1.02] text-balance">
                <Emph text={copy.waitlist.title} />
              </h2>
              <p className={bodyCls}>{copy.waitlist.body}</p>
            </div>
            <div className="mt-10 lg:col-span-6 lg:col-start-7 lg:mt-2">
              <Waitlist
                copy={copy}
                c={{
                  form: "grid gap-6 sm:grid-cols-[1fr_11rem] sm:items-end",
                  label: kickerCls,
                  input: "atl-field h-11 w-full text-[1.0625rem]",
                  select: "atl-field h-11 w-full text-[1.0625rem]",
                  button: `${btnPrimary} justify-self-start sm:col-span-2`,
                  note: "font-geist text-[0.8125rem] leading-relaxed text-(--a-muted) sm:col-span-2",
                  status: "font-geist text-[0.9375rem] sm:col-span-2",
                }}
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="atl-wrap pb-24">
        <div aria-hidden="true" className="atl-double" />
        <div className="flex flex-col gap-8 pt-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="flex items-center gap-2.5">
              <Logo size={22} />
              <span className="font-serif text-[1.5rem] leading-none">Terno</span>
            </p>
            <p className="mt-3 font-serif text-[1.25rem] text-(--a-muted) italic">{copy.footer.tagline}</p>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 font-geist text-[0.875rem]">
            <li>
              <a href={privacy} className="atl-nav">
                {copy.footer.privacy}
              </a>
            </li>
            <li>
              <a href={GITHUB} className="atl-nav">
                {copy.footer.source}
              </a>
            </li>
            <li>
              <a href={LICENSE_URL} className="atl-nav">
                {copy.footer.license}
              </a>
            </li>
            <li>
              <a href={copy.nav.languageHref} className="atl-nav" lang={copy.lang === "es" ? "en" : "es"}>
                {copy.nav.language}
              </a>
            </li>
            <li className="text-(--a-muted)">{copy.footer.copyright}</li>
          </ul>
        </div>
      </footer>
    </div>
  );
};
