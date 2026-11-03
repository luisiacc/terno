import type { ReactNode } from "react";
import { ArrowLeft } from "./icons";
import type { SiteCopy } from "../copy";
import type { Route } from "../site";
import { Logo } from "./logo";
import { Rich } from "./rich";
import { Waitlist, WaitlistOutcomes } from "./waitlist";

/**
 * The pages that aren't the home page (privacy, the download stand-in, the waitlist's no-JS landing, 404): one
 * quiet column, the same in every design, so choosing a design only changes the home page.
 */
function Plain({ copy, children }: { copy: SiteCopy; children: ReactNode }) {
  const home = copy.lang === "es" ? "/es/" : "/";
  return (
    <div className="site-plain min-h-dvh bg-(--plain-bg) text-(--plain-fg)">
      <a href="#main" className="site-skip">
        {copy.skip}
      </a>
      <header className="mx-auto flex max-w-2xl items-center justify-between px-6 py-8">
        <a href={home} className="flex items-center gap-2.5 font-semibold" aria-label={copy.nav.home}>
          <Logo size={28} />
          <span>Terno</span>
        </a>
        <a href={home} className="flex items-center gap-1.5 text-sm text-(--plain-muted) hover:text-(--plain-fg)">
          <ArrowLeft size="1.15em" />
          {copy.nav.home}
        </a>
      </header>
      <main id="main" className="mx-auto max-w-2xl px-6 pb-24">
        {children}
      </main>
    </div>
  );
}

const h1 = "mt-6 text-4xl font-semibold tracking-tight text-balance";
const lead = "mt-4 text-lg text-(--plain-muted) text-pretty";
const prose = "mt-3 leading-relaxed text-(--plain-muted) text-pretty";
const formClasses = {
  form: "mt-10 grid gap-4 sm:grid-cols-[1fr_10rem] sm:items-end",
  label: "text-sm font-medium",
  input: "h-11 rounded-xl border border-(--plain-line) bg-transparent px-3.5 text-base",
  select: "h-11 rounded-xl border border-(--plain-line) bg-transparent px-3",
  button: "h-11 rounded-xl bg-(--plain-fg) px-5 font-medium text-(--plain-bg) sm:col-span-2 sm:justify-self-start",
  note: "text-sm text-(--plain-muted) sm:col-span-2",
  status: "sm:col-span-2",
};

export function SecondaryPage({ route, copy }: { route: Route; copy: SiteCopy }) {
  const p = copy.pages;
  if (route.page === "privacy")
    return (
      <Plain copy={copy}>
        <h1 className={h1}>{p.privacy.title}</h1>
        <p className={lead}>{p.privacy.intro}</p>
        <p className="mt-3 text-sm text-(--plain-muted)">{p.privacy.updated}</p>
        <nav aria-label={p.privacy.contents} className="mt-10 border-y border-(--plain-line) py-5">
          <h2 className="text-sm font-medium text-(--plain-muted)">{p.privacy.contents}</h2>
          <ol className="mt-3 gap-x-6 text-sm sm:columns-2 [&>li]:py-0.75">
            {p.privacy.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="hover:underline hover:underline-offset-4">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        {p.privacy.sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="mt-12 scroll-mt-8">
            <h2 id={`${s.id}-title`} className="text-xl font-semibold">
              {s.title}
            </h2>
            {s.body.map((para) => (
              <p key={para} className={prose}>
                <Rich text={para} />
              </p>
            ))}
            {s.points && (
              <ul className="mt-3 grid list-disc gap-2 pl-5 leading-relaxed text-(--plain-muted) marker:text-(--plain-line)">
                {s.points.map((point) => (
                  <li key={point}>
                    <Rich text={point} />
                  </li>
                ))}
              </ul>
            )}
            {s.after?.map((para) => (
                <p key={para} className={prose}>
                  <Rich text={para} />
                </p>
              ))}
          </section>
        ))}
      </Plain>
    );
  if (route.page === "download")
    return (
      <Plain copy={copy}>
        <h1 className={h1}>{p.download.title}</h1>
        <p className={lead}>{p.download.body}</p>
        <Waitlist copy={copy} id="download-waitlist" platform="mac" c={formClasses} />
      </Plain>
    );
  if (route.page === "waitlist")
    return (
      <Plain copy={copy}>
        <WaitlistOutcomes copy={copy} className="mt-6 rounded-xl px-4 py-3 text-base" />
        <h1 className={h1}>{p.waitlist.title}</h1>
        <p className={lead}>{copy.waitlist.body}</p>
        <Waitlist copy={copy} id="page-waitlist" c={formClasses} />
      </Plain>
    );
  return (
    <Plain copy={copy}>
      <h1 className={h1}>{p.notFound.title}</h1>
      <p className={lead}>{p.notFound.body}</p>
      <p className="mt-8">
        <a href="/" className="font-medium underline underline-offset-4">
          {p.notFound.home}
        </a>
      </p>
    </Plain>
  );
}
