import type { ReactNode } from "react";
import type { SiteCopy } from "../copy";
import { DownloadMac, WaitlistLink } from "../parts/download";
import { Github } from "../parts/icons";
import { Kbd } from "../parts/kbd";
import { Logo } from "../parts/logo";
import { PRO_LEAD, PRO_MORE, Peek, ProLeadShot, proPrivacyLink } from "../parts/pro";
import { DESIGN_SHOTS, Shot, type ShotName } from "../parts/shot";
import { Waitlist } from "../parts/waitlist";
import { Window } from "../parts/window";
import { GITHUB, LICENSE_URL } from "../site";
import type { HomeDesign } from "./types";

/**
 * Letter (plan 97, design 5): one narrow reading column, written like a letter about mail that stays yours.
 * Shots are figures that break out of the column (`.letter-wide`); section pictures stay in it. Layout and colors: letter.css.
 */

// the shortcuts the copy mentions in passing (⌘; ⌘K ⌘J and a lone ?) become keycaps where they stand
const KEY_RE = /(⌘;|⌘K|⌘J|(?<=\s)\?(?=\s))/;
const withKeys = (text: string) => text.split(KEY_RE).map((part, i) => (i % 2 ? <Kbd key={i} className="letter-kbd">{part}</Kbd> : part));

const link = "text-(--l-link) underline decoration-(--l-link)/30 underline-offset-[0.22em] transition-colors duration-100 hover:decoration-(--l-link)";
const quiet = "text-(--l-muted) transition-colors duration-100 hover:text-(--l-ink)";
const button =
  "inline-flex items-center gap-3 rounded-full bg-(--l-ink) py-2.5 pr-6 pl-5 text-[15px] font-medium text-(--l-bg) transition-opacity duration-100 hover:opacity-85";

type FeatureId = keyof SiteCopy["features"];

function Feature({ copy, id, children }: { copy: SiteCopy; id: FeatureId; children?: ReactNode }) {
  const f = copy.features[id];
  return (
    <section aria-labelledby={`f-${id}`} className="letter-sub mt-28 sm:mt-36">
      <h2 id={`f-${id}`} className="mt-3 text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.022em] text-balance sm:text-[2.125rem]">
        {withKeys(f.title)}
      </h2>
      <p className="letter-prose mt-5">{withKeys(f.body)}</p>
      {f.points.length > 0 && (
        <ul className="letter-points mt-6">
          {f.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/** A full screenshot in a window, wider than the column. */
function Figure({ copy, name, eager, className = "" }: { copy: SiteCopy; name: ShotName; eager?: boolean; className?: string }) {
  return (
    <figure className={`letter-wide ${className}`}>
      <Window className="letter-window">
        <Shot name={name} copy={copy} eager={eager} sizes="(min-width: 1180px) 1088px, calc(100vw - 2.5rem)" />
      </Window>
      <figcaption className="letter-caption">{copy.alt[name]}</figcaption>
    </figure>
  );
}

/** One part of the app from its own section picture (`<part>-detail`), set in the column like a quotation. */
function Detail({ copy, name, wide = "" }: { copy: SiteCopy; name: ShotName; wide?: string }) {
  return (
    <figure className="mt-12">
      <div className={`letter-detail ${wide}`}>
        <Shot name={name} copy={copy} sizes="(min-width: 700px) 640px, calc(100vw - 2.5rem)" className="block h-auto w-full" />
      </div>
      <figcaption className="letter-caption">{copy.alt[name]}</figcaption>
    </figure>
  );
}

/** A Pro feature in the letter's voice: a smaller heading than the features', its words, its points. */
function ProFeature({ f, children }: { f: SiteCopy["pro"]["reply"] | SiteCopy["pro"]["digest"]; children: ReactNode }) {
  return (
    <>
      <h3 className="mt-20 text-[1.375rem] leading-[1.2] font-semibold tracking-[-0.02em] text-balance sm:mt-24 sm:text-[1.625rem]">{withKeys(f.title)}</h3>
      <p className="letter-prose mt-4">{withKeys(f.body)}</p>
      {f.points.length > 0 && (
        <ul className="letter-points mt-6">
          {f.points.map((p) => (
            <li key={p}>{withKeys(p)}</li>
          ))}
        </ul>
      )}
      {children}
    </>
  );
}

/**
 * Terno Pro (plan 97), after the features: a new part of the letter with a "Coming soon" chip and the planned
 * price, the drafted reply as a wide figure, the other four in the column, each picture peeking up into a quiet
 * stage, then what AI sends and the own-key note. Violet marks the name, nothing louder.
 */
function Pro({ copy }: { copy: SiteCopy }) {
  const p = copy.pro;
  const privacyAi = proPrivacyLink(copy);
  return (
    <section id="pro" aria-labelledby="pro-title" className="letter-sub mt-28 scroll-mt-20 sm:mt-36">
      <p className="flex flex-wrap items-center gap-3 text-[15px]">
        <span className="letter-pro font-semibold">{p.eyebrow}</span>
        <span className="letter-pro-chip rounded-full px-2.5 py-1 text-[12.5px] leading-none font-medium">{p.status}</span>
      </p>
      <h2 id="pro-title" className="mt-4 text-[2.25rem] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[3rem]">
        {p.title}
      </h2>
      <p className="letter-prose letter-lead mt-6">{p.body}</p>
      <p className="mt-4 text-[14px] text-(--l-muted)">{p.price}</p>

      <ProFeature f={p[PRO_LEAD.id]}>
        <figure className="letter-wide mt-14">
          <Window className="letter-window site-pro-lead-window">
            <ProLeadShot copy={copy} sizes="(min-width: 1180px) 1088px, (min-width: 640px) calc(100vw - 2.5rem), 200vw" />
          </Window>
          <figcaption className="letter-caption">{copy.alt[PRO_LEAD.shot]}</figcaption>
        </figure>
      </ProFeature>
      {PRO_MORE.map(({ id, shot }) => (
        <ProFeature key={id} f={p[id]}>
          <figure className="mt-10">
            <Peek name={shot} copy={copy} sizes="(min-width: 700px) 600px, 92vw" className="letter-pro-stage pt-[6%]" frameClassName="letter-pro-frame" />
            <figcaption className="letter-caption">{copy.alt[shot]}</figcaption>
          </figure>
        </ProFeature>
      ))}

      <p className="letter-prose mt-20 sm:mt-24">{p.privacy}</p>
      <p className="mt-4 text-[14px] leading-relaxed text-(--l-muted)">
        {p.ownKey}{" "}
        <a href={privacyAi.href} className={`whitespace-nowrap ${link}`}>
          {privacyAi.label}
        </a>
      </p>
    </section>
  );
}

export const Letter: HomeDesign = ({ copy }) => {
  const privacy = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const home = copy.lang === "es" ? "/es/" : "/";
  const f = copy.features;
  return (
    <div className="letter min-h-dvh bg-(--l-bg) font-system text-(--l-ink)">
      <a href="#main" className="site-skip">
        {copy.skip}
      </a>

      <header className="letter-bar sticky top-0 z-40">
        <div className="mx-auto flex h-12 max-w-[40rem] items-center justify-between px-5 min-[42.5rem]:px-0">
          <a href={home} aria-label={copy.nav.home} className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <Logo size={20} />
            <span aria-hidden="true">Terno</span>
          </a>
          <nav className="flex items-center gap-5 text-[14px]">
            <a href="#pro" className={quiet}>
              {copy.nav.pro}
            </a>
            <a href={copy.nav.languageHref} hrefLang={copy.lang === "en" ? "es" : "en"} className={quiet}>
              {copy.nav.language}
            </a>
            <a href="/download/mac" data-download="mac" className="font-medium text-(--l-link) transition-opacity duration-100 hover:opacity-80">
              {copy.nav.download}
            </a>
          </nav>
        </div>
      </header>

      <main id="main" className="letter-flow pt-20 sm:pt-32">
        <h1 className="mt-5 text-[2.75rem] leading-[1.02] font-semibold tracking-[-0.04em] text-balance sm:text-[4.25rem]">{copy.hero.title}</h1>
        <p className="letter-prose letter-lead mt-8">{copy.hero.subtitle}</p>
        <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
          <DownloadMac copy={copy} className={button} subClassName="text-[12px] font-normal opacity-65" />
          <WaitlistLink copy={copy} className={`text-[15px] ${link}`} />
        </div>
        <p className="mt-5 text-[14px] text-(--l-muted)">{copy.hero.note}</p>

        <Figure copy={copy} name="inbox" eager className="mt-20 sm:mt-24" />

        <Feature copy={copy} id="unified" />
        <Feature copy={copy} id="local" />
        <Feature copy={copy} id="search">
          <Detail copy={copy} name="search-detail" />
        </Feature>
        <Feature copy={copy} id="speed">
          <ul className="letter-stats mt-14">
            {copy.stats.map((s) => (
              <li key={s.label}>
                <span className="block text-[2.75rem] leading-none font-light tracking-[-0.04em] tabular-nums sm:text-[3.25rem]">{s.value}</span>
                <span className="mt-3 block text-[15px] leading-snug text-(--l-muted)">{s.label}</span>
              </li>
            ))}
          </ul>
        </Feature>
        <Feature copy={copy} id="triage">
          <Figure copy={copy} name="file-similar" className="mt-14" />
        </Feature>
        <Feature copy={copy} id="codes">
          <Detail copy={copy} name="code-detail" />
        </Feature>
        <Feature copy={copy} id="themes">
          {/* the five designs and one palette pair: three by two, two by three on a phone */}
          <ul className="letter-wide mt-14 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 sm:gap-5">
            {[...DESIGN_SHOTS.map(([, name]) => name), "palette-dracula" as const].map((name) => (
              <li key={name}>
                <figure>
                  <Window className="letter-window letter-window-small">
                    <Shot name={name} copy={copy} sizes="(min-width: 1180px) 350px, (min-width: 640px) 31vw, 45vw" />
                  </Window>
                  <figcaption className="letter-caption">{copy.alt[name]}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </Feature>
        <Feature copy={copy} id="snippets">
          <Figure copy={copy} name="snippets" className="mt-14" />
        </Feature>
        <Feature copy={copy} id="palette">
          <Detail copy={copy} name="palette-detail" wide="site-wide" />
        </Feature>
        <Feature copy={copy} id="keyboard">
          <dl className="letter-keys mt-10">
            {copy.keys.map((k) => (
              <div key={k.label}>
                <dt>
                  {k.keys.map((key) => (
                    <Kbd key={key} className="letter-kbd">
                      {key}
                    </Kbd>
                  ))}
                </dt>
                <dd>{k.label}</dd>
              </div>
            ))}
          </dl>
        </Feature>
        <Feature copy={copy} id="open">
          <p className="mt-8 text-[17px]">
            <a href={GITHUB} className={`inline-flex items-center gap-2 ${link}`}>
              <Github size="1.15em" />
              {f.open.cta}
            </a>
          </p>
        </Feature>

        <Pro copy={copy} />

        <section aria-labelledby="closing" className="letter-sub mt-28 sm:mt-36">
          <hr className="mb-14 w-12 border-(--l-ink) sm:mb-20" />
          <h2 id="closing" className="text-[2.5rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[3.5rem]">
            {copy.closing.title}
          </h2>
          <p className="letter-prose letter-lead mt-6">{copy.closing.body}</p>
          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
            <DownloadMac copy={copy} className={button} subClassName="text-[12px] font-normal opacity-65" />
          </div>
          <p className="mt-12 flex items-center gap-2.5 text-[15px] text-(--l-muted)" aria-hidden="true">
            <Logo size={18} />
            <span>Terno</span>
          </p>
        </section>

        <section id="waitlist" aria-labelledby="waitlist-title" className="letter-sub mt-28 sm:mt-36">
          <h2 id="waitlist-title" className="text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] sm:text-[1.75rem]">
            {copy.waitlist.title}
          </h2>
          <p className="letter-prose mt-4">{copy.waitlist.body}</p>
          <Waitlist
            copy={copy}
            c={{
              form: "mt-8 grid gap-4 sm:grid-cols-[1fr_10rem] sm:items-end",
              label: "text-[14px] font-medium text-(--l-soft)",
              input: "letter-field h-12 px-4",
              select: "letter-field h-12 px-3.5",
              button: `${button} justify-self-start sm:col-span-2`,
              note: "text-[14px] leading-relaxed text-(--l-muted) sm:col-span-2",
              status: "text-[15px] sm:col-span-2",
            }}
          />
        </section>
      </main>

      <footer className="letter-flow mt-32 pb-28 sm:mt-40">
        <div className="flex flex-col gap-6 border-t border-(--l-line) pt-8 text-[14px] sm:flex-row sm:items-baseline sm:justify-between">
          <p className="text-(--l-soft)">{copy.footer.tagline}</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <a href={privacy} className={quiet}>
                {copy.footer.privacy}
              </a>
            </li>
            <li>
              <a href={GITHUB} className={quiet}>
                {copy.footer.source}
              </a>
            </li>
            <li>
              <a href={LICENSE_URL} className={quiet}>
                {copy.footer.license}
              </a>
            </li>
            <li>
              <a href={copy.nav.languageHref} hrefLang={copy.lang === "en" ? "es" : "en"} className={quiet}>
                {copy.nav.language}
              </a>
            </li>
            <li className="text-(--l-muted)">{copy.footer.copyright}</li>
          </ul>
        </div>
      </footer>
    </div>
  );
};
