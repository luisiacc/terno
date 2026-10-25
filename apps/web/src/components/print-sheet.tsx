import { captureUi, log } from "~/lib/diag";
import type { ThreadDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@terno/ui/components/dialog";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { cn } from "@terno/ui/lib/utils";
import { PRINT_INK } from "@terno/ui/themes/print";
import { t } from "@terno/i18n";
import { CircleAlert, FileDown, ImageOff, Info, LoaderCircle, Printer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { hasRemoteContent } from "~/lib/mail";
import { buildPrintDocument, defaultPaper, dropPendingImages, fitPrintDocument, PAGE, printFileName, remoteUrls, serializePrintDocument, settlePrintDocument, type Paper, type PrintMessage, type PrintOptions } from "~/lib/print";
import type { PrintIntent, PrintTarget } from "~/lib/print-open";
import { remoteAllowed, useRemoteConsent } from "~/lib/remote-consent";
import { setApp, useApp } from "~/state/app";
import { loadThread, useThreads } from "~/state/threads";
import { SettingsGroup, SettingsRow } from "./settings/parts";

type Scope = "thread" | "message";
type Quoted = PrintOptions["quoted"];

/** What the sheet remembers between prints: content, paper, and quoted text per scope (the scope itself comes from where it opened). */
interface Prefs {
  content: PrintOptions["content"];
  paper: Paper;
  quoted: Record<Scope, Quoted>;
}
const PREFS_KEY = "terno:print";

function readPrefs(): Prefs {
  // a whole conversation hides quotes (every reply would reprint the history); one message keeps them
  const fallback: Prefs = { content: "headers", paper: defaultPaper(navigator.language), quoted: { thread: "hide", message: "show" } };
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!v || typeof v !== "object") return fallback;
    const q = (x: unknown, d: Quoted): Quoted => (x === "hide" || x === "show" ? x : d);
    return {
      content: v.content === "body" || v.content === "headers" ? v.content : fallback.content,
      paper: v.paper === "a4" || v.paper === "letter" ? v.paper : fallback.paper,
      quoted: { thread: q(v.quoted?.thread, "hide"), message: q(v.quoted?.message, "show") },
    };
  } catch {
    return fallback;
  }
}

/** The messages a print takes: the whole conversation, or "this message" (the one it opened on, else the last), each with its remote-content answer. */
function printMessages(detail: ThreadDetail | undefined, scope: Scope, messageId: number | null, policy: { remoteImages: "ask" | "always"; localMode: boolean }, allowed: ReadonlySet<number>): PrintMessage[] {
  const all = detail?.messages ?? [];
  const single = all.find((m) => m.id === messageId) ?? all[all.length - 1];
  return (scope === "message" && single ? [single] : all).map((m) => ({
    id: m.id,
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    bodyHtml: m.bodyHtml,
    bodyText: m.bodyText,
    attachments: m.attachments,
    allowRemote: remoteAllowed(m.id, policy, allowed),
  }));
}

const MM_PX = 96 / 25.4;
/** How long the preview waits for fonts and images before it is printable anyway. */
const READY_DEADLINE_MS = 4000;
const desktop = () => (window.ternoDesktop?.print ? window.ternoDesktop : null);

/** The sheet's own state outlives nothing: it mounts per target (keyed), so every opening starts from its entry point. */
export function PrintSheet() {
  const target = useApp((s) => s.printTarget);
  const close = () => setApp({ dialog: null, printTarget: null });
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target && <Sheet key={`${target.threadId}:${target.messageId}:${target.intent}`} target={target} onClose={close} />}
    </Dialog>
  );
}

function Sheet({ target, onClose }: { target: PrintTarget; onClose: () => void }) {
  // the cached copy shows at once; a fresh one (bodies downloaded since) replaces it
  const [detail, setDetail] = useState<ThreadDetail | undefined>(() => useThreads.getState().details.get(target.threadId));
  const [fetchFailed, setFetchFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void loadThread(target.threadId, true).then((d) => {
      if (!live) return;
      if (d) setDetail(d);
      else setFetchFailed(true);
    });
    return () => {
      live = false;
    };
  }, [target.threadId]);

  const [prefs, setPrefs] = useState(readPrefs);
  // merged into the latest choices, not the ones this render saw: quick changes never undo each other
  const update = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const [stored] = useState(prefs);
  useEffect(() => {
    if (prefs === stored) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: remembered for this sheet only */
    }
  }, [prefs]);
  const [scope, setScope] = useState<Scope>(target.messageId !== null ? "message" : "thread");
  const quoted = prefs.quoted[scope];

  const settings = useApp((s) => s.settings);
  const allowed = useRemoteConsent((s) => s.allowed);
  const policy = { remoteImages: settings?.remoteImages ?? "ask", localMode: settings?.localMode ?? true };
  const all = detail?.messages ?? [];
  const messages = printMessages(detail, scope, target.messageId, policy, allowed);
  const subject = detail?.thread.subject ?? "";
  const missing = messages.filter((m) => m.bodyHtml === null && m.bodyText === null).length;
  const blocked = messages.filter((m) => !m.allowRemote && m.bodyHtml && hasRemoteContent(m.bodyHtml)).length;

  // what the document is built from; a change settles for 120 ms first, so toggling through options builds once
  const inputs = useMemo(() => ({ detail, scope, prefs, allowed, policy }), [detail, scope, prefs, allowed, policy.remoteImages, policy.localMode]);
  const [settled, setSettled] = useState(inputs);
  useEffect(() => {
    if (settled === inputs) return;
    // the first document (the thread just arrived) builds at once
    if (!settled.detail) return setSettled(inputs);
    const timer = setTimeout(() => setSettled(inputs), 120);
    return () => clearTimeout(timer);
  }, [inputs]);
  const shown = useMemo(() => {
    const { detail: d, scope: sc, prefs: p, allowed: al, policy: po } = settled;
    if (!d) return null;
    const options: PrintOptions = { content: p.content, quoted: p.quoted[sc], paper: p.paper };
    return { html: buildPrintDocument({ subject: d.thread.subject, messages: printMessages(d, sc, target.messageId, po, al) }, options), paper: p.paper };
  }, [settled]);

  const [fitted, setFitted] = useState<{ html: string; remote: string[]; frame: HTMLIFrameElement } | null>(null);
  const [busy, setBusy] = useState<PrintIntent | null>(null);
  // a rebuild on its way: what's on screen isn't what would print
  const current = shown !== null && settled === inputs;
  const ready = fitted !== null && current && busy === null;
  const restoreTitle = useRef<(() => void) | null>(null);
  useEffect(() => () => restoreTitle.current?.(), []);

  const run = async (intent: PrintIntent) => {
    if (!fitted || busy) return;
    const host = desktop();
    if (!host) return printInBrowser(intent);
    setBusy(intent);
    try {
      const result = await host.print!({ html: fitted.html, action: intent, paper: prefs.paper, subject, headers: prefs.content === "headers", remote: fitted.remote });
      if (result.status === "saved") {
        onClose();
        snack(t("print.saved"), { description: result.name, action: { label: t("print.showInFinder"), onClick: () => void host.showSaved?.(result.exportId) } });
      } else if (result.status === "submitted") onClose();
      else if (result.status === "failed") {
        // main recorded the failure itself; here it is a step on the trail
        log.warn("print.failed", { action: intent, reason: result.reason === "no-printers" ? "other" : "error" });
        if (result.reason === "no-printers") snack.error(t("print.noPrinters"), { description: t("print.noPrinters.hint") });
        else snack.error(intent === "pdf" ? t("print.pdfFailed") : t("print.failed"));
      }
    } catch (error) {
      captureUi(error, { code: "print.failed", fields: { action: intent } });
      snack.error(intent === "pdf" ? t("print.pdfFailed") : t("print.failed"));
    } finally {
      setBusy(null);
    }
  };

  /** The browser prints the preview's own document; its title (and the page's, which some browsers use) names the PDF. */
  const printInBrowser = (_intent: PrintIntent) => {
    const win = fitted!.frame.contentWindow;
    if (!win) return;
    const before = document.title;
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      document.title = before;
      restoreTitle.current = null;
      clearTimeout(timer);
    };
    restoreTitle.current = restore;
    const timer = setTimeout(restore, 60_000);
    win.addEventListener("afterprint", restore, { once: true });
    document.title = printFileName(subject);
    try {
      win.print();
    } finally {
      restore();
    }
    onClose();
  };

  const primary: PrintIntent = target.intent;
  const primaryRef = useRef<HTMLButtonElement>(null);
  const web = desktop() === null;
  const count = all.length;

  return (
    <DialogContent
      initialFocus={primaryRef}
      // narrow (a small window, or zoomed in): preview above, options below, the sheet scrolls and the buttons stay in view;
      // the scroll padding keeps a focused control from landing under them
      className="flex max-h-[90vh] w-[min(960px,94vw)] max-w-none scroll-pb-16 flex-col gap-0 overflow-x-hidden overflow-y-auto p-0 sm:max-w-[min(960px,94vw)] md:h-[min(660px,90vh)] md:scroll-pb-0 md:flex-row md:overflow-hidden"
      data-testid="print-sheet"
      onKeyDown={(e) => {
        // Return prints (or saves, from ⇧⌘P), unless a control has its own use for it
        if (e.key === "Enter" && !e.defaultPrevented && !(e.target as Element).closest("button, [role=radio], input, a")) {
          e.preventDefault();
          void run(primary);
        }
      }}
    >
      <Preview doc={shown} current={current} onFitted={setFitted} />
      <div className="hairline-t flex w-full shrink-0 flex-col md:w-[340px] md:border-t-0 md:hairline-l">
        <div className="px-5 pt-5 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">{scope === "message" && count > 1 ? t("print.titleMessage") : t("print.title")}</DialogTitle>
          <DialogDescription className="mt-1 truncate text-xs" data-testid="print-subject">
            {subject || t("common.noSubject")}
          </DialogDescription>
        </div>
        <div className="px-5 pb-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
          <SettingsGroup>
            {count > 1 && (
              <SettingsRow label={t("print.scope")} stacked>
                {(a) => (
                  <Segmented a={a} full value={scope} onChange={(v) => setScope(v as Scope)} testId="print-scope" items={[["thread", t("print.scope.thread", { count })], ["message", t("print.scope.message")]]} />
                )}
              </SettingsRow>
            )}
            <SettingsRow label={t("print.content")} hint={prefs.content === "headers" ? t("print.content.headersHint") : t("print.content.bodyHint")} stacked>
              {(a) => <Segmented a={a} full value={prefs.content} onChange={(v) => update({ content: v as Prefs["content"] })} testId="print-content" items={[["headers", t("print.content.headers")], ["body", t("print.content.body")]]} />}
            </SettingsRow>
            <SettingsRow label={t("print.quoted")}>
              {(a) => <Segmented a={a} value={quoted} onChange={(v) => setPrefs((p) => ({ ...p, quoted: { ...p.quoted, [scope]: v as Quoted } }))} testId="print-quoted" items={[["hide", t("print.quoted.hide")], ["show", t("print.quoted.show")]]} />}
            </SettingsRow>
            <SettingsRow label={t("print.paper")}>
              {(a) => <Segmented a={a} value={prefs.paper} onChange={(v) => update({ paper: v as Paper })} testId="print-paper" items={[["letter", t("print.paper.letter")], ["a4", "A4"]]} />}
            </SettingsRow>
          </SettingsGroup>
          <div className="mt-4 space-y-2.5 px-1 text-xs text-muted-foreground">
            {fetchFailed && (
              <Note icon={CircleAlert} testId="print-note-error" tone="warn">
                {t("print.note.fetchFailed")}
              </Note>
            )}
            {missing > 0 && (
              <Note icon={CircleAlert} testId="print-note-missing" tone="warn">
                {t("print.note.missing", { count: missing })}
              </Note>
            )}
            {blocked > 0 && (
              <Note icon={ImageOff} testId="print-note-remote">
                {policy.localMode ? t("print.note.remoteLocal") : t("print.note.remote")}
              </Note>
            )}
            {web && (
              <Note icon={Info} testId="print-hint-web">
                {t("print.note.web")}
              </Note>
            )}
          </div>
        </div>
        <div className="hairline-t sticky bottom-0 z-20 flex flex-wrap items-center justify-end gap-2 bg-popover px-5 py-3.5">
          <Button
            ref={primary === "pdf" ? primaryRef : undefined}
            variant={primary === "pdf" ? "default" : "outline"}
            // focusable while the preview settles: it is where focus starts (Return prints)
            disabled={!ready}
            focusableWhenDisabled
            onClick={() => void run("pdf")}
            data-testid="print-save-pdf"
          >
            {busy === "pdf" ? <LoaderCircle className="animate-spin" /> : <FileDown />}
            {t("print.savePdf")}
          </Button>
          <Button
            ref={primary === "print" ? primaryRef : undefined}
            variant={primary === "print" ? "default" : "outline"}
            disabled={!ready}
            focusableWhenDisabled
            onClick={() => void run("print")}
            data-testid="print-submit"
          >
            {busy === "print" ? <LoaderCircle className="animate-spin" /> : <Printer />}
            {t("print.print")}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

/** A macOS segmented control: a recessed track, the chosen segment raised on it. */
function Segmented({ a, value, onChange, items, testId, full }: { a: { "aria-labelledby": string; "aria-describedby"?: string }; value: string; onChange: (v: string) => void; items: [string, string][]; testId: string; full?: boolean }) {
  return (
    <ToggleGroup
      aria-labelledby={a["aria-labelledby"]}
      aria-describedby={a["aria-describedby"]}
      spacing={0}
      value={[value]}
      onValueChange={(v: string[]) => v[0] && onChange(v[0])}
      className={cn("gap-0 rounded-[calc(var(--radius-lg)+1px)] bg-foreground/[0.07] p-0.5", full && "w-full")}
      data-testid={testId}
    >
      {items.map(([v, label]) => (
        <ToggleGroupItem
          key={v}
          value={v}
          data-testid={`${testId}-${v}`}
          className={cn(
            "min-h-6 h-auto min-w-0 rounded-[calc(var(--radius-md)+1px)]! px-3 py-0.5 text-[12.5px] leading-tight font-medium whitespace-normal text-muted-foreground transition-[background-color,color,box-shadow] hover:bg-transparent hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-raised dark:aria-pressed:bg-foreground/[0.14]",
            full && "flex-1",
          )}
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Note({ icon: Icon, children, testId, tone }: { icon: typeof Info; children: React.ReactNode; testId: string; tone?: "warn" }) {
  return (
    <p className="flex gap-2 leading-relaxed" data-testid={testId}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone === "warn" && "text-cat-amber-ink")} />
      <span>{children}</span>
    </p>
  );
}

/**
 * The real print document on white paper at the selected width, scaled to the
 * pane (the scaling stays outside the document). Once it has loaded, settled
 * and been fitted, the fitted page is what prints.
 */
function Preview({ doc, current, onFitted }: { doc: { html: string; paper: Paper } | null; current: boolean; onFitted: (f: { html: string; remote: string[]; frame: HTMLIFrameElement } | null) => void }) {
  const html = doc?.html ?? null;
  const paper = doc?.paper ?? "letter";
  const pane = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [ready, setReady] = useState(false);
  const paperPx = PAGE[paper].width * MM_PX;
  const scale = width ? Math.min(1, (width - (width < 500 ? 32 : 64)) / paperPx) : 0;

  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const f = frame.current;
    if (!f || html === null) return;
    let live = true;
    let done = false;
    setReady(false);
    onFitted(null);
    // the deadline runs from navigation, not from load (which itself waits for every image)
    const started = performance.now();
    const previous = f.contentDocument;
    const finish = async () => {
      const doc = f.contentDocument;
      // not this build's document yet (the old one, or still parsing): load will come
      if (done || !live || !doc || doc === previous || !doc.documentElement.hasAttribute("data-print-doc")) return;
      done = true;
      await settlePrintDocument(doc, Math.max(0, READY_DEADLINE_MS - (performance.now() - started)));
      if (!live) return;
      // still loading at the deadline (a stalled server): printed as their description, never waited on again
      dropPendingImages(doc);
      fitPrintDocument(doc);
      // the body's box, not scrollHeight (which never drops below the frame's own height)
      setHeight(Math.ceil(doc.body.getBoundingClientRect().height));
      setReady(true);
      onFitted({ html: serializePrintDocument(doc), remote: remoteUrls(doc), frame: f });
    };
    const onLoad = () => void finish();
    const timer = setTimeout(onLoad, READY_DEADLINE_MS);
    f.addEventListener("load", onLoad);
    return () => {
      live = false;
      clearTimeout(timer);
      f.removeEventListener("load", onLoad);
    };
  }, [html]);

  return (
    <div ref={pane} className="relative h-[40vh] min-h-44 min-w-0 shrink-0 overflow-y-auto bg-tint md:h-auto md:flex-1 md:shrink" data-testid="print-preview-pane">
      <div className="px-4 py-4 md:px-8 md:py-8">
        <div
          className="mx-auto overflow-hidden rounded-[3px] shadow-popover transition-opacity duration-base data-pending:opacity-60"
          data-pending={!(ready && current) || undefined}
          style={{ width: paperPx * scale, height: Math.max(height, PAGE[paper].height * MM_PX) * scale, background: PRINT_INK.paper }}
        >
          <iframe
            ref={frame}
            title={t("print.preview")}
            data-testid="print-preview"
            data-ready={(ready && current) || undefined}
            data-paper={paper}
            sandbox="allow-same-origin allow-modals"
            srcDoc={html ?? undefined}
            tabIndex={-1}
            className="block border-0"
            style={{ width: paperPx, height: Math.max(height, PAGE[paper].height * MM_PX), transform: `scale(${scale})`, transformOrigin: "0 0" }}
          />
        </div>
      </div>
      {!(ready && current) && <LoaderCircle aria-hidden className="absolute top-4 right-4 size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}
