import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ORIGINAL_HTML_MAX, ORIGINAL_SOURCE_MAX, type AuthVerdict, type OriginalResult, type OriginalSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { announce } from "~/lib/announce";
import { formatBytes, fullDate } from "~/lib/format";
import { downloadOriginal, readOriginal } from "~/lib/original";
import { originalFilename } from "@terno/core";
import { snack } from "~/lib/snack";
import { useThread } from "~/state/threads";
import { useMailReaderView } from "./mail-reader-view";

/**
 * Plan 272: Show original. A message's ⋯ menu or right-click opens it over the conversation (the reader's own view,
 * plan 188's: Back, Esc or the mouse's back button return to the message, focus and scroll as they were). The menus
 * reach it through this context; one original at a time, and none from inside another view.
 */
interface OriginalOpener {
  open(threadId: number, messageId: number, trigger: HTMLElement): void;
}
const Context = createContext<OriginalOpener | null>(null);
export const useOriginalOpener = () => useContext(Context);

/** Where focus lands when Show original opens (the menu hands it over after its closing animation) */
export const originalBack = () => document.querySelector<HTMLElement>("[data-original-back]");

export function OriginalHost({ children }: { children: ReactNode }) {
  const view = useMailReaderView();
  const [open, setOpen] = useState<{ threadId: number; messageId: number; lease: object } | null>(null);
  const opener = useMemo<OriginalOpener | null>(() => view && {
    open(threadId, messageId, trigger) {
      const lease = {};
      setOpen({ threadId, messageId, lease });
      view.open(lease, trigger);
    },
  }, [view]);
  // another conversation took the reader: this one's original is over, never shown again on coming back (Codex code review #4)
  const threadShown = view?.threadId ?? null;
  useEffect(() => {
    if (!open || threadShown === open.threadId) return;
    view?.close(open.lease, false);
    setOpen(null);
  }, [threadShown, open, view]);
  const shown = open && view?.active === open.lease && view.target ? open : null;
  return (
    <Context.Provider value={opener}>
      {children}
      {shown && createPortal(<OriginalMessage key={`${shown.messageId}`} threadId={shown.threadId} messageId={shown.messageId} onClose={() => view!.close(shown.lease)} />, view!.target!)}
    </Context.Provider>
  );
}

type Reading =
  | { state: "reading" }
  | { state: "read"; view: Extract<OriginalResult, { size: number }>; requestId: string }
  | { state: "none"; reason: Extract<OriginalResult, { unavailable: string }>["unavailable"] }
  | { state: "failed"; message: string };

type Part = "headers" | "html" | "source";

function OriginalMessage({ threadId, messageId, onClose }: { threadId: number; messageId: number; onClose(): void }) {
  const view = useMailReaderView();
  const back = useRef<HTMLButtonElement>(null);
  const detail = useThread(threadId);
  const message = detail?.messages.find((m) => m.id === messageId);
  // the HTML the reader renders, from this computer: no server needed (plan 272, revision 8)
  const html = message?.bodyHtml ?? null;
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  const [part, setPart] = useState<Part>("headers");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<Part | null>(null);
  /** every reading this view started, each closed when it's replaced or the view goes (Codex code review #3) */
  const readings = useRef(new Set<ReturnType<typeof readOriginal>>());
  /** the view's life: a download stops with it */
  const life = useRef<AbortController | null>(null);
  useLayoutEffect(() => { view?.focus(back.current); }, []);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    const open = readings.current;
    return () => { controller.abort(); for (const r of open) r.close(); open.clear(); };
  }, []);
  const start = useCallback(() => {
    const r = readOriginal(threadId, messageId);
    readings.current.add(r);
    return r;
  }, [threadId, messageId]);
  const retire = (r: ReturnType<typeof readOriginal>) => { r.close(); readings.current.delete(r); };

  useEffect(() => {
    const r = start();
    let live = true;
    setReading({ state: "reading" });
    r.result.then(
      (result) => { if (live) setReading("unavailable" in result ? { state: "none", reason: result.unavailable } : { state: "read", view: result, requestId: r.requestId }); },
      (error: unknown) => { if (live) setReading({ state: "failed", message: error instanceof Error ? error.message : t("errors.original.unreachable") }); },
    );
    return () => { live = false; retire(r); };
  }, [start, attempt]);

  const read = reading.state === "read" ? reading.view : null;
  const text: Record<Part, string> = { headers: read?.headers ?? "", html: html ?? "", source: read?.source ?? "" };
  const parts = (["headers", "html", "source"] as const).filter((p) => (p === "html" ? html : read));
  const tab: Part = parts.includes(part) ? part : (parts[0] ?? "headers");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text[tab]);
      setCopied(tab);
      // plan 188: the button's own words changing isn't heard while focus stays on it
      announce(t("common.copied"));
    } catch { setCopied(null); snack.error(t("threadMenu.copyFailed")); }
  };

  const download = async () => {
    const signal = life.current?.signal;
    if (reading.state !== "read" || busy || !signal || signal.aborted) return;
    const previous = [...readings.current].find((r) => r.requestId === reading.requestId);
    // the kept bytes went (two minutes untouched): a fresh reading, kept by this view, replaces the one shown
    const again = async () => {
      const r = start();
      const result = await r.result.catch(() => null);
      if (signal.aborted || !result || "unavailable" in result) { retire(r); return null; }
      if (previous) retire(previous);
      setReading({ state: "read", view: result, requestId: r.requestId });
      return { requestId: r.requestId, size: result.size };
    };
    setBusy(true);
    try {
      if (await downloadOriginal({ requestId: reading.requestId, size: reading.view.size }, again, originalFilename(message?.subject ?? "", t("reader.original.filename")), signal)) announce(t("reader.original.downloaded"));
    } catch (error) {
      if (!signal.aborted) snack.error(error instanceof Error && error.message ? error.message : t("reader.original.downloadFailed"));
    } finally { if (!signal.aborted) setBusy(false); }
  };

  const copyLabel = copied === tab ? t("common.copied") : t(tab === "headers" ? "reader.original.copyHeaders" : tab === "html" ? "reader.original.copyHtml" : "reader.original.copySource");
  // BoardUI's secondary link, quiet as the full message's header is; unavailable ones stay focusable (Codex code review #10)
  const control = "font-normal text-muted-foreground hover:text-foreground hover:no-underline";
  return (
    // data-own-keys: arrows, Delete and Backspace are this view's (scrolling), never the conversation's (Codex code review #2)
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="original-message" data-own-keys aria-busy={reading.state === "reading"}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3.5 py-3">
        <Button ref={back} variant="link-secondary" data-original-back onClick={onClose} className={control}>{t("reader.full.back")}</Button>
        <h2 className="type-body font-semibold">{t("reader.original.title")}</h2>
        <div className="ml-auto flex items-center gap-4">
          <Button variant="link-secondary" data-testid="original-copy" className={control} disabled={!text[tab]} focusableWhenDisabled onClick={() => void copy()}>{copyLabel}</Button>
          <Button variant="link-secondary" data-testid="original-download" className={control} disabled={!read} focusableWhenDisabled loading={busy} onClick={() => void download()}>{t(busy ? "reader.original.downloading" : "reader.original.download")}</Button>
        </div>
      </header>
      <div tabIndex={0} role="region" aria-label={t("reader.original.title")} className="min-h-0 flex-1 overflow-y-auto outline-none" data-original-scroller>
        {reading.state === "reading" && <p role="status" className="px-3.5 py-3 text-sm text-muted-foreground">{t("reader.original.loading")}</p>}
        {reading.state === "none" && <p role="status" data-testid="original-none" className="px-3.5 py-3 text-sm text-muted-foreground">{reading.reason === "gone" ? t("errors.original.gone") : t(`reader.original.${reading.reason}` as "reader.original.local")}</p>}
        {reading.state === "failed" && (
          <p role="alert" data-testid="original-failed" className="flex flex-wrap items-baseline gap-x-3 px-3.5 py-3 text-sm">
            <span>{reading.message}</span>
            {/* the button goes with the failure it answers: focus waits on Back meanwhile */}
            <Button variant="link" data-testid="original-retry" onClick={() => { back.current?.focus(); setAttempt((a) => a + 1); }}>{t("reader.original.tryAgain")}</Button>
          </p>
        )}
        {read && <Summary summary={read.summary} />}
        {(read || html) && (
          <Tabs value={tab} onValueChange={(v) => { setPart(v as Part); setCopied(null); }} className="gap-0">
            {/* inset as the summary's hairlines are */}
            <div className="px-3.5">
            <TabsList variant="line" aria-label={t("reader.original.parts")} className="w-full justify-start gap-4">
              {read && <TabsTrigger value="headers" className="px-0 group-data-horizontal/tabs:flex-none" data-testid="original-tab-headers">{t("reader.original.headers")}</TabsTrigger>}
              {html && <TabsTrigger value="html" className="px-0 group-data-horizontal/tabs:flex-none" data-testid="original-tab-html">{t("reader.original.html")}</TabsTrigger>}
              {read && <TabsTrigger value="source" className="px-0 group-data-horizontal/tabs:flex-none" data-testid="original-tab-source">{t("reader.original.source")}</TabsTrigger>}
            </TabsList>
            </div>
            {read && (
              <TabsContent value="headers" className="px-3.5 py-3" data-testid="original-headers">
                {read.headersCut && <Note>{t("reader.original.headersCut")}</Note>}
                <Code text={read.headers} />
              </TabsContent>
            )}
            {html && (
              <TabsContent value="html" className="px-3.5 py-3" data-testid="original-html">
                <Note>{t("reader.original.htmlNote")}</Note>
                {html.length > ORIGINAL_HTML_MAX && <Note>{t("reader.original.htmlCut")}</Note>}
                <Code text={html.length > ORIGINAL_HTML_MAX ? html.slice(0, ORIGINAL_HTML_MAX) : html} />
              </TabsContent>
            )}
            {read && (
              <TabsContent value="source" className="px-3.5 py-3" data-testid="original-source">
                {read.sourceCut && <Note>{t("reader.original.sourceCut", { shown: formatBytes(Math.min(ORIGINAL_SOURCE_MAX, read.size)), size: formatBytes(read.size) })}</Note>}
                <Code text={read.source} />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs text-muted-foreground">{children}</p>;
}

const verdict = (v: AuthVerdict) => (v.about ? t("reader.original.verdict", { result: v.result.toUpperCase(), about: v.about }) : v.result.toUpperCase());

/** Gmail's summary over the original: what the headers say, on hairlines, label beside value */
function Summary({ summary }: { summary: OriginalSummary }) {
  const rows: [string, string][] = [];
  if (summary.messageId) rows.push(["messageId", summary.messageId]);
  if (summary.date) rows.push(["created", summary.date.time === null ? summary.date.text : fullDate(summary.date.time)]);
  for (const key of ["from", "to", "cc", "subject", "deliveredTo"] as const) if (summary[key]) rows.push([key, summary[key]]);
  const auth = summary.auth;
  for (const key of ["spf", "dkim", "dmarc"] as const) if (auth?.[key]) rows.push([key, verdict(auth[key])]);
  // the verdicts are what a server wrote into the message, not checked here: whose they are is said (Codex review #7)
  if (auth) rows.push(["reporter", auth.reporter]);
  if (!rows.length) return null;
  return (
    <dl aria-label={t("reader.original.summary")} data-testid="original-summary" className="grid grid-cols-[max-content_minmax(0,1fr)] px-3.5 pt-1 pb-3 text-sm">
      {rows.map(([key, value]) => (
        <div key={key} data-testid={`original-${key}`} className="col-span-2 grid grid-cols-subgrid gap-x-6 py-1.5 hairline-b">
          <dt className="text-muted-foreground">{t(`reader.original.${key}` as "reader.original.from")}</dt>
          <dd className="min-w-0 break-words select-text">{value}</dd>
        </div>
      ))}

    </dl>
  );
}

/** A long text in blocks a browser lays out only when they come into view (a megabyte of source stays quick) */
function Code({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: string[] = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + 16_384);
      const line = text.indexOf("\n", end);
      end = end === text.length ? end : line < 0 ? text.length : line + 1;
      out.push(text.slice(at, end));
      at = end;
    }
    return out;
  }, [text]);
  return (
    <div className="font-mono text-xs break-all whitespace-pre-wrap select-text">
      {blocks.map((block, i) => <div key={i} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 400px" }}>{block}</div>)}
    </div>
  );
}
