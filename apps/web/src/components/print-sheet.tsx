import type { ThreadDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@terno/ui/components/dialog";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { cn } from "@terno/ui/lib/utils";
import { PRINT_INK } from "@terno/ui/themes/print";
import { CircleAlert, FileDown, ImageOff, Info, LoaderCircle, Printer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { hasRemoteContent } from "~/lib/mail";
import { buildPrintDocument, defaultPaper, fitPrintDocument, PAGE, printFileName, remoteUrls, serializePrintDocument, settlePrintDocument, type Paper, type PrintMessage, type PrintOptions } from "~/lib/print";
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

const MM_PX = 96 / 25.4;
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
  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* private mode: remembered for this sheet only */
    }
  };
  const [scope, setScope] = useState<Scope>(target.messageId !== null ? "message" : "thread");
  const quoted = prefs.quoted[scope];

  const settings = useApp((s) => s.settings);
  const allowed = useRemoteConsent((s) => s.allowed);
  const all = detail?.messages ?? [];
  // "this message": the one the sheet was opened on, else the last one
  const single = all.find((m) => m.id === target.messageId) ?? all[all.length - 1];
  const chosen = scope === "message" && single ? [single] : all;
  const policy = { remoteImages: settings?.remoteImages ?? "ask", localMode: settings?.localMode ?? true };
  const messages: PrintMessage[] = chosen.map((m) => ({
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
  const subject = detail?.thread.subject ?? "";
  const missing = messages.filter((m) => m.bodyHtml === null && m.bodyText === null).length;
  const blocked = messages.filter((m) => !m.allowRemote && m.bodyHtml && hasRemoteContent(m.bodyHtml)).length;
  const options: PrintOptions = { content: prefs.content, quoted, paper: prefs.paper };

  // option changes rebuild after a short pause; the first build is immediate
  const built = useMemo(() => (detail ? { html: buildPrintDocument({ subject, messages }, options), paper: options.paper } : null), [detail, scope, prefs, allowed, policy.remoteImages, policy.localMode]);
  const [shown, setShown] = useState(built);
  useEffect(() => {
    if (shown === null) return setShown(built);
    const t = setTimeout(() => setShown(built), 120);
    return () => clearTimeout(t);
  }, [built]);

  const [fitted, setFitted] = useState<{ html: string; remote: string[]; frame: HTMLIFrameElement } | null>(null);
  const [busy, setBusy] = useState<PrintIntent | null>(null);
  // a rebuild on its way: what's on screen isn't what would print
  const current = shown !== null && shown === built;
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
        toast("PDF guardado", { description: result.name, action: { label: "Mostrar en Finder", onClick: () => void host.showSaved?.(result.exportId) } });
      } else if (result.status === "submitted") onClose();
      else if (result.status === "failed") {
        if (result.reason === "no-printers") toast.error("No hay impresoras configuradas", { description: "Usa «Guardar PDF…» para guardar el correo como PDF." });
        else toast.error(intent === "pdf" ? "No se pudo guardar el PDF" : "No se pudo imprimir");
      }
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
      className="flex h-[min(660px,90vh)] w-[min(960px,94vw)] max-w-none flex-row gap-0 overflow-hidden p-0 sm:max-w-[min(960px,94vw)]"
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
      <div className="hairline-l flex w-[340px] shrink-0 flex-col">
        <div className="px-5 pt-5 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">{scope === "message" && count > 1 ? "Imprimir mensaje" : "Imprimir"}</DialogTitle>
          <DialogDescription className="mt-1 truncate text-xs" data-testid="print-subject">
            {subject || "(sin asunto)"}
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <SettingsGroup>
            {count > 1 && (
              <SettingsRow label="Alcance" stacked>
                {(a) => (
                  <Segmented a={a} full value={scope} onChange={(v) => setScope(v as Scope)} testId="print-scope" items={[["thread", `Conversación (${count})`], ["message", "Solo este mensaje"]]} />
                )}
              </SettingsRow>
            )}
            <SettingsRow label="Contenido" hint={prefs.content === "headers" ? "Asunto, remitente, fecha, destinatarios y adjuntos." : "Solo el texto del correo: sin asunto, remitente ni fechas."} stacked>
              {(a) => <Segmented a={a} full value={prefs.content} onChange={(v) => update({ content: v as Prefs["content"] })} testId="print-content" items={[["headers", "Con encabezados"], ["body", "Solo el contenido"]]} />}
            </SettingsRow>
            <SettingsRow label="Texto citado">
              {(a) => <Segmented a={a} value={quoted} onChange={(v) => update({ quoted: { ...prefs.quoted, [scope]: v as Quoted } })} testId="print-quoted" items={[["hide", "Ocultar"], ["show", "Incluir"]]} />}
            </SettingsRow>
            <SettingsRow label="Papel">
              {(a) => <Segmented a={a} value={prefs.paper} onChange={(v) => update({ paper: v as Paper })} testId="print-paper" items={[["letter", "Carta"], ["a4", "A4"]]} />}
            </SettingsRow>
          </SettingsGroup>
          <div className="mt-4 space-y-2.5 px-1 text-xs text-muted-foreground">
            {fetchFailed && (
              <Note icon={CircleAlert} testId="print-note-error" tone="warn">
                No se pudo actualizar la conversación: se imprime la copia guardada.
              </Note>
            )}
            {missing > 0 && (
              <Note icon={CircleAlert} testId="print-note-missing" tone="warn">
                {missing === 1 ? "Un mensaje aún no se ha descargado: se imprimirá sin contenido." : `${missing} mensajes aún no se han descargado: se imprimirán sin contenido.`}
              </Note>
            )}
            {blocked > 0 && (
              <Note icon={ImageOff} testId="print-note-remote">
                {policy.localMode ? "El modo local bloquea las imágenes remotas: no se imprimirán." : "Las imágenes remotas que no cargaste en el lector no se imprimirán."}
              </Note>
            )}
            {web && (
              <Note icon={Info} testId="print-hint-web">
                Para un PDF, elige «Guardar como PDF» como destino. Desactiva «Encabezados y pies de página» para una página limpia.
              </Note>
            )}
          </div>
        </div>
        <div className="hairline-t flex items-center justify-end gap-2 px-5 py-3.5">
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
            Guardar PDF…
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
            Imprimir…
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
      className={cn("gap-0 rounded-[9px] bg-foreground/[0.07] p-0.5", full && "w-full")}
      data-testid={testId}
    >
      {items.map(([v, label]) => (
        <ToggleGroupItem
          key={v}
          value={v}
          data-testid={`${testId}-${v}`}
          className={cn(
            "h-6 min-w-0 rounded-[7px]! px-3 text-[12.5px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] hover:bg-transparent hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-raised dark:aria-pressed:bg-foreground/[0.14]",
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
  const scale = width ? Math.min(1, (width - 64) / paperPx) : 0;

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
    setReady(false);
    onFitted(null);
    const onLoad = async () => {
      const doc = f.contentDocument;
      if (!doc || !live) return;
      await settlePrintDocument(doc);
      if (!live) return;
      fitPrintDocument(doc);
      // the body's box, not scrollHeight (which never drops below the frame's own height)
      setHeight(Math.ceil(doc.body.getBoundingClientRect().height));
      setReady(true);
      onFitted({ html: serializePrintDocument(doc), remote: remoteUrls(doc), frame: f });
    };
    f.addEventListener("load", onLoad);
    return () => {
      live = false;
      f.removeEventListener("load", onLoad);
    };
  }, [html]);

  return (
    <div ref={pane} className="relative min-w-0 flex-1 overflow-y-auto bg-tint" data-testid="print-preview-pane">
      <div className="px-8 py-8">
        <div
          className="mx-auto overflow-hidden rounded-[3px] shadow-popover transition-opacity duration-base data-pending:opacity-60"
          data-pending={!(ready && current) || undefined}
          style={{ width: paperPx * scale, height: Math.max(height, PAGE[paper].height * MM_PX) * scale, background: PRINT_INK.paper }}
        >
          <iframe
            ref={frame}
            title="Vista previa de impresión"
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
