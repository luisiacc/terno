import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "@terno/i18n";
import { HtmlBody, type HtmlBodyProps } from "./mail-body";
import { ReaderAttachments } from "./attachments";
import { MessageMenu } from "./message-menu";
import { useMailReaderView } from "./mail-reader-view";
import { snack } from "~/lib/snack";
import { prepareMailDisplay } from "./mail-graphic";
import { mailSections } from "./mail-sections";

export default function FullMessage({ html, source, onClose, controls, copyText, ...props }: HtmlBodyProps & { source(signal: AbortSignal): Promise<{ root: HTMLElement; tabs: WeakMap<Node, string | null> }>; onClose(): void; controls: ReactNode; copyText(): string }) {
  const view = useMailReaderView();
  const [nodeBudget, setNodeBudget] = useState(64);
  const [prepared, setPrepared] = useState<{ html: string; display: Awaited<ReturnType<typeof prepareMailDisplay>> } | null>(null);
  const [failedPreparation, setFailedPreparation] = useState(false);
  useEffect(() => {
    const cancellation = new AbortController();
    void source(cancellation.signal).then((original) => prepareMailDisplay(original, cancellation.signal)).then((display) => {
      if (!cancellation.signal.aborted) setPrepared({ html, display });
    }, () => { if (!cancellation.signal.aborted) setFailedPreparation(true); });
    return () => cancellation.abort();
  }, [html, source]);
  const display = prepared?.html === html ? prepared.display : null;
  const sections = useMemo(() => display ? mailSections(display.root, nodeBudget) : null, [display, nodeBudget]);
  const [anchor, setAnchor] = useState(0);
  const index = sections?.indexAt(anchor) ?? 0;
  const sectionHtml = useMemo(() => sections?.html(index) ?? "", [sections, index]);
  const [ready, setReady] = useState(false);
  const [failedLayout, setFailedLayout] = useState(false);
  useLayoutEffect(() => setReady(false), [sectionHtml]);
  const scroller = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => { view?.focus(back.current); }, []);
  const move = (next: number) => {
    setReady(false); setAnchor(sections!.offset(next)); setCopied(false);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const measured = (height: number) => {
    if (height > 4_000_000) {
      if (nodeBudget === 1) { setFailedLayout(true); return false; }
      setReady(false); setNodeBudget(Math.max(1, Math.floor(nodeBudget / 2)));
      return false;
    }
    setReady(true);
    return true;
  };
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([copyText()], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      setCopied(true);
    } catch { setCopied(false); snack.error(t("threadMenu.copyFailed")); }
  };
  if (failedLayout || failedPreparation) throw new Error("Mail section layout could not be reflowed");
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-labelledby="full-message-heading" data-testid="full-message" aria-busy={!display || !ready}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3.5 py-3">
        <button ref={back} type="button" onClick={onClose} className="rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2">{t("reader.full.back")}</button>
        <h2 id="full-message-heading" className="type-body font-semibold">{t("reader.full.title")}</h2>
        <button type="button" className="ml-auto rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2" onClick={() => void copy()}>{t(copied ? "reader.full.copied" : "reader.full.copy")}</button>
      </header>
      <div className="flex shrink-0 items-center gap-3 px-3.5 py-2 text-sm" aria-label={t("reader.full.sections")}>
        <button type="button" disabled={!sections || index === 0} onClick={() => move(index - 1)} className="rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:ring-2">{t("reader.full.previous")}</button>
        <span role="status">{t("reader.full.part", { part: index + 1, count: sections?.count ?? 1 })}</span>
        <button type="button" disabled={!sections || index + 1 === sections.count} onClick={() => move(index + 1)} className="rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:ring-2">{t("reader.full.next")}</button>
      </div>
      <div ref={scroller} tabIndex={0} role="region" aria-label={t("reader.full.title")} className="min-h-0 flex-1 overflow-y-auto outline-none" data-full-message-scroller>
        <p className="px-3.5 py-2 text-xs text-muted-foreground">{t("reader.full.reflow")}</p>
        <div className="px-3.5">{controls}</div>
        {!ready && <p role="status" className="px-3.5 py-2 text-sm text-muted-foreground">{t("reader.full.loading")}</p>}
        <div style={{ visibility: ready ? undefined : "hidden" }}>
        {display && (view?.threadId !== null && view?.threadId !== undefined ? <MessageMenu threadId={view.threadId}><div className="px-3.5 pb-8" data-message-id={props.messageId}><HtmlBody {...props} key={`${nodeBudget}:${index}`} html={sectionHtml} section onExit={onClose} onSectionHeight={measured} hydrate={display.hydrate} onHydrationError={() => setFailedLayout(true)} /></div></MessageMenu> : <div className="px-3.5 pb-8"><HtmlBody {...props} key={`${nodeBudget}:${index}`} html={sectionHtml} section onExit={onClose} onSectionHeight={measured} hydrate={display.hydrate} onHydrationError={() => setFailedLayout(true)} /></div>)}
        </div>
        {props.accountId !== undefined && Boolean(props.attachments?.length) && <div className="px-3.5 pb-8"><ReaderAttachments accountId={props.accountId} messageId={props.messageId} attachments={props.attachments!} /></div>}
      </div>
    </section>
  );
}
