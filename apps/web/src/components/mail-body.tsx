import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@unica/ui/components/popover";
import { Button } from "@unica/ui/components/button";
import { setApp } from "~/state/app";
import { mailColors, useAppearance } from "~/lib/appearance";
import { csp, hasOwnColors, hasRemoteContent } from "~/lib/mail";

function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (window.unicaDesktop) window.unicaDesktop.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

const MAX_HEIGHT = 20000;

/** The last measured height of each message's frame: an expanding message opens to it, not to a guess. */
const heights = new Map<number, number>();
const HEIGHTS_MAX = 500;
function rememberHeight(key: number | undefined, h: number) {
  if (key === undefined) return;
  heights.delete(key);
  heights.set(key, h);
  if (heights.size > HEIGHTS_MAX) heights.delete(heights.keys().next().value!);
}

/**
 * Renders an HTML email in a sandboxed iframe: sanitized with DOMPurify, no
 * scripts (sandbox without allow-scripts), strict CSP, links opened externally.
 * allow-same-origin (without scripts) only lets the parent measure the height.
 */
export function HtmlBody({ html, cacheKey, remoteImages, localMode, appearance }: { html: string; cacheKey?: number; remoteImages: "ask" | "always"; localMode: boolean; appearance: "auto" | "paper" }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [userAllowed, setAllowRemote] = useState(remoteImages === "always");
  // local mode: remote content is never loaded, whatever the setting or a click says
  const allowRemote = userAllowed && !localMode;
  const [height, setHeight] = useState(() => (cacheKey !== undefined ? heights.get(cacheKey) : undefined) ?? 120);
  const blocked = !allowRemote && hasRemoteContent(html);
  // re-rendered when the painted theme changes (the colors are literals inside the document)
  const themeKey = useAppearance((s) => s.themeKey);
  const mode = useAppearance((s) => s.mode);
  const clean = useMemo(() => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ["style"], FORBID_ATTR: ["srcset"], ADD_ATTR: ["target"] }), [html]);
  const paper = appearance === "paper" || hasOwnColors(clean);
  const doc = useMemo(() => {
    const c = mailColors()[paper ? "paper" : "themed"];
    // the CSP is unchanged by theming: local mode keeps the strict policy (allowRemote is false there)
    return `<!doctype html><html data-mail="${paper ? "paper" : "themed"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allowRemote)}"><base target="_blank"><style>html{overflow-y:hidden}html,body{margin:0;padding:0;background:${c.bg};color:${c.fg};font:14px/1.55 -apple-system,BlinkMacSystemFont,"Geist Variable",sans-serif;overflow-wrap:anywhere;color-scheme:${paper ? "light" : mode}}body{padding:${paper ? "16px" : "0"}}img{max-width:100%;height:auto}a{color:${c.link}}table{max-width:100%}</style></head><body>${clean}</body></html>`;
  }, [clean, allowRemote, paper, themeKey, mode]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // everything attached to the loaded document goes when the document or the frame does
    let observer: ResizeObserver | null = null;
    let detach: (() => void) | null = null;
    const onLoad = () => {
      observer?.disconnect();
      detach?.();
      const d = frame.contentDocument;
      if (!d) return;
      // the frame is sized to its content, so it never scrolls inside. The box (not scrollHeight, which
      // never drops below the frame and rounds down) shrinks back and covers fractional heights.
      const measure = () => {
        const content = Math.ceil(d.documentElement.getBoundingClientRect().height);
        // past the cap the document scrolls: hidden content would be unreachable
        d.documentElement.style.overflowY = content > MAX_HEIGHT ? "auto" : "";
        const h = Math.min(MAX_HEIGHT, content);
        rememberHeight(cacheKey, h);
        setHeight(h);
      };
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(d.documentElement);
      const onClick = (e: MouseEvent) => {
        const a = (e.target as Element).closest("a");
        if (a?.href) {
          e.preventDefault();
          openLink(a.href);
        }
      };
      d.addEventListener("click", onClick);
      detach = () => d.removeEventListener("click", onClick);
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      detach?.();
    };
  }, [doc]);

  return (
    <div>
      {blocked && <RemoteBlocked localMode={localMode} onLoad={() => setAllowRemote(true)} />}
      {/* themed mail flows on the page with no box; mail with its own colors keeps a borderless paper surface */}
      <div className={paper ? "overflow-hidden rounded-lg bg-[var(--mail-paper)]" : undefined}>
        <iframe
          ref={ref}
          title="Contenido del correo"
          sandbox="allow-same-origin allow-popups"
          srcDoc={doc}
          style={{ height }}
          data-mail={paper ? "paper" : "themed"}
          className="block w-full border-0"
        />
      </div>
    </div>
  );
}

/**
 * The remote-content row: a full-width tinted row with a pill on the right.
 * In local mode the pill only explains (nothing remote is ever loaded there).
 */
function RemoteBlocked({ localMode, onLoad }: { localMode: boolean; onLoad: () => void }) {
  const pill = "ml-auto h-[22px] shrink-0 rounded-full bg-accent px-2.5 text-[11.5px] font-medium text-accent-foreground transition-colors hover:text-foreground";
  return (
    <div className="mb-3 flex h-9 items-center gap-2.5 rounded-lg bg-tint pr-1.5 pl-3 text-xs text-muted-foreground" data-testid="remote-blocked">
      <ImageOff className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{localMode ? "Contenido remoto bloqueado por el modo local." : "Contenido remoto bloqueado para proteger tu privacidad."}</span>
      {localMode ? (
        <Popover>
          <PopoverTrigger render={<button type="button" className={pill} data-testid="remote-why" />}>Cargar contenido…</PopoverTrigger>
          <PopoverContent align="end" className="w-72 gap-3 text-xs" data-testid="remote-why-popover">
            <p className="text-sm text-popover-foreground">El modo local no permite cargar contenido remoto: solo se conecta con tus servidores de correo.</p>
            <Button size="sm" variant="outline" className="self-end" onClick={() => setApp({ dialog: "settings", settingsTab: "general" })}>
              Abrir Ajustes
            </Button>
          </PopoverContent>
        </Popover>
      ) : (
        <button type="button" className={pill} onClick={onLoad} data-testid="remote-load">
          Cargar contenido
        </button>
      )}
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/** Plain-text body: quoted history folded, links clickable. */
export function TextBody({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const lines = text.split("\n");
  const firstQuote = lines.findIndex((l, i) => l.startsWith(">") || (/escribió:$|wrote:$/.test(l.trim()) && lines[i + 1]?.startsWith(">")));
  const main = firstQuote > 0 ? lines.slice(0, firstQuote).join("\n").trimEnd() : text;
  const quoted = firstQuote > 0 ? lines.slice(firstQuote).join("\n") : "";
  const render = (s: string) =>
    s.split(URL_RE).map((part, i) =>
      i % 2 ? (
        <a key={i} href={part} className="text-primary underline-offset-2 hover:underline" onClick={(e) => (e.preventDefault(), openLink(part))}>
          {part}
        </a>
      ) : (
        part
      ),
    );
  return (
    <div className="text-base leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
      {render(main)}
      {quoted && (
        <>
          <button type="button" onClick={() => setShowQuoted((v) => !v)} className="mt-2 block rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground hover:text-foreground" aria-label={showQuoted ? "Ocultar texto citado" : "Mostrar texto citado"} aria-expanded={showQuoted}>
            •••
          </button>
          {showQuoted && <div className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">{render(quoted)}</div>}
        </>
      )}
    </div>
  );
}
