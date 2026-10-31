import type { ReactNode } from "react";
import { ArrowLeft } from "./icons";
import type { SiteCopy } from "../copy";
import type { Route } from "../site";
import { Logo } from "./logo";
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
        {p.privacy.sections.map((s) => (
          <section key={s.title} className="mt-10">
            <h2 className="text-xl font-semibold">{s.title}</h2>
            <p className="mt-2 leading-relaxed text-(--plain-muted)">{s.body}</p>
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
