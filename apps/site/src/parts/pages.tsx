import { Fragment, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronRight, Copy, Download } from "./icons";
import type { SiteCopy } from "../copy";
import { GITHUB, LICENSE_URL, pathIn, type Route } from "../site";
import { Logo } from "./logo";
import { Rich } from "./rich";
import { Waitlist, WaitlistOutcomes } from "./waitlist";

/**
 * The pages that aren't the home page (privacy, terms, the download stand-in, the waitlist's no-JS landing, 404): one
 * quiet column, the same in every design, so choosing a design only changes the home page. Its footer keeps the
 * legal pages one click from each other.
 */
function Plain({ copy, route, children }: { copy: SiteCopy; route: Route; children: ReactNode }) {
  const home = copy.lang === "es" ? "/es/" : "/";
  const otherLang = copy.lang === "es" ? "en" : "es";
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
      <footer className="mx-auto max-w-2xl px-6 pb-16">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-(--plain-line) pt-6 text-sm text-(--plain-muted)">
          <li>
            <a href={pathIn(copy.lang, "privacy")} className="hover:text-(--plain-fg)">
              {copy.footer.privacy}
            </a>
          </li>
          <li>
            <a href={pathIn(copy.lang, "terms")} className="hover:text-(--plain-fg)">
              {copy.footer.terms}
            </a>
          </li>
          <li>
            <a href={LICENSE_URL} className="hover:text-(--plain-fg)">
              {copy.footer.license}
            </a>
          </li>
          {/* the same page in the other language, where there is one */}
          {route.alternate && (
            <li>
              <a href={route.alternate} hrefLang={otherLang} lang={otherLang} className="hover:text-(--plain-fg)">
                {copy.nav.language}
              </a>
            </li>
          )}
          <li>{copy.footer.copyright}</li>
        </ul>
      </footer>
    </div>
  );
}

const h1 = "mt-6 text-4xl font-semibold tracking-tight text-balance";
const lead = "mt-4 text-lg text-(--plain-muted) text-pretty";
const prose = "mt-3 leading-relaxed text-(--plain-muted) text-pretty";
const formClasses = {
  form: "mt-10 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end",
  label: "text-sm font-medium",
  input: "h-11 rounded-xl border border-(--plain-line) bg-transparent px-3.5 text-base",
  button: "h-11 justify-self-start rounded-xl bg-(--plain-fg) px-5 font-medium text-(--plain-bg)",
  note: "text-sm text-(--plain-muted) sm:col-span-2",
  status: "sm:col-span-2",
};

const releasesLink = "inline-flex items-center gap-1 font-medium underline decoration-(--plain-line) underline-offset-4 hover:decoration-(--plain-fg)";

/** the Linux packages, each a Worker path (worker/download.ts), its architecture's label, and its install command */
const PACKAGES = {
  deb: [
    { arch: "x64", path: "/download/linux/deb", command: "sudo apt install ./Terno-*-linux-amd64.deb" },
    { arch: "arm64", path: "/download/linux/deb-arm64", command: "sudo apt install ./Terno-*-linux-arm64.deb" },
  ],
  rpm: [
    { arch: "x64", path: "/download/linux/rpm", command: "sudo dnf install ./Terno-*-linux-x86_64.rpm" },
    { arch: "arm64", path: "/download/linux/rpm-arm64", command: "sudo dnf install ./Terno-*-linux-aarch64.rpm" },
  ],
} as const;

/**
 * /download/linux/ (plan 254): the four packages by family and processor, x86-64 first (the common one). Each button
 * is the Worker's path for its file in the latest release; under each, the command that installs exactly that file.
 */
function LinuxPage({ copy, route }: { copy: SiteCopy; route: Route }) {
  const l = copy.pages.linux;
  const query = copy.lang === "es" ? "?lang=es" : "";
  return (
    <Plain copy={copy} route={route}>
      {/* a package that couldn't be reached lands here on #unavailable, and only then does this show (site.css) */}
      <p id="unavailable" role="status" className="site-outcome site-outcome-error mt-6 rounded-xl px-4 py-3">
        <Rich text={l.unavailable} />
      </p>
      <h1 className={h1}>{l.title}</h1>
      <p className={lead}>{l.lead}</p>
      <p className={prose}>{l.install}</p>
      {(["deb", "rpm"] as const).map((family) => (
        <section key={family} aria-labelledby={`linux-${family}`} className="mt-12">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id={`linux-${family}`} className="text-xl font-semibold">
              {l[family]}
            </h2>
            <span aria-hidden="true" className="font-mono text-sm text-(--plain-muted)">
              .{family}
            </span>
          </div>
          <ul className="site-pkgs mt-4">
            {PACKAGES[family].map((pkg) => (
              <li key={pkg.path} className="grid gap-4 p-4 sm:p-5">
                <div className="grid gap-3 sm:flex sm:items-center sm:justify-between sm:gap-6">
                  <div>
                    <p className="font-medium">{l[pkg.arch]}</p>
                    <p className="text-sm text-(--plain-muted)">{l[`${pkg.arch}Hint`]}</p>
                  </div>
                  <a href={`${pkg.path}${query}`} className="site-dl">
                    <Download size="1.15em" />
                    {l.download} .{family}
                    <span className="sr-only"> · {l[pkg.arch]}</span>
                  </a>
                </div>
                <div className="site-cmd">
                  <span aria-hidden="true" className="self-start select-none text-(--plain-muted)">
                    $
                  </span>
                  {/* on a phone it wraps between words only, never inside the file's name */}
                  <code className="min-w-0 flex-1">
                    {pkg.command.split(" ").map((word, i) => (
                      <Fragment key={i}>
                        {i > 0 && " "}
                        <span className="whitespace-nowrap">{word}</span>
                      </Fragment>
                    ))}
                  </code>
                  {/* only with the script (client.ts), which copies it and says so in the status beside it */}
                  <button type="button" className="site-copy" data-copy={pkg.command} data-copied-label={l.copied} aria-label={l.copy} title={l.copy}>
                    <Copy size={15} />
                    <Check size={15} />
                  </button>
                  <span role="status" className="sr-only" data-copy-status />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="mt-12 border-t border-(--plain-line) pt-6">
        <p className={prose}>
          <Rich text={l.older} />
        </p>
        <p className={prose}>
          <Rich text={l.which} />
        </p>
        <p className={prose}>{l.updates}</p>
      </div>
      <p className="mt-8">
        <a href={`${GITHUB}/releases`} className={releasesLink}>
          {l.releases}
          <ChevronRight size="1.15em" />
        </a>
      </p>
    </Plain>
  );
}

/** a legal page's copy (privacy, terms): sections a contents list links to, each prose with an optional list */
interface LegalDoc {
  title: string;
  intro: string;
  updated: string;
  contents: string;
  sections: readonly { id: string; title: string; body: readonly string[]; points?: readonly string[]; after?: readonly string[] }[];
}

/** Privacy and Terms: the title, when it last changed, the contents, then each section under its own anchor. */
function LegalPage({ copy, route, doc }: { copy: SiteCopy; route: Route; doc: LegalDoc }) {
  return (
    <Plain copy={copy} route={route}>
      <h1 className={h1}>{doc.title}</h1>
      <p className={lead}>{doc.intro}</p>
      <p className="mt-3 text-sm text-(--plain-muted)">{doc.updated}</p>
      <nav aria-label={doc.contents} className="mt-10 border-y border-(--plain-line) py-5">
        <h2 className="text-sm font-medium text-(--plain-muted)">{doc.contents}</h2>
        <ol className="mt-3 gap-x-6 text-sm sm:columns-2 [&>li]:py-0.75">
          {doc.sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="hover:underline hover:underline-offset-4">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {doc.sections.map((s) => (
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
}

export function SecondaryPage({ route, copy }: { route: Route; copy: SiteCopy }) {
  const p = copy.pages;
  if (route.page === "privacy") return <LegalPage copy={copy} route={route} doc={p.privacy} />;
  if (route.page === "terms") return <LegalPage copy={copy} route={route} doc={p.terms} />;
  if (route.page === "download")
    return (
      <Plain copy={copy} route={route}>
        <h1 className={h1}>{p.download.title}</h1>
        <p className={lead}>{p.download.body}</p>
        <p className="mt-8">
          <a href={`${GITHUB}/releases`} className={releasesLink}>
            {p.download.releases}
            <ChevronRight size="1.15em" />
          </a>
        </p>
      </Plain>
    );
  if (route.page === "linux") return <LinuxPage copy={copy} route={route} />;
  if (route.page === "waitlist")
    return (
      <Plain copy={copy} route={route}>
        <WaitlistOutcomes copy={copy} className="mt-6 rounded-xl px-4 py-3 text-base" />
        <h1 className={h1}>{p.waitlist.title}</h1>
        <p className={lead}>{copy.waitlist.body}</p>
        <Waitlist copy={copy} id="page-waitlist" c={formClasses} />
      </Plain>
    );
  return (
    <Plain copy={copy} route={route}>
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
