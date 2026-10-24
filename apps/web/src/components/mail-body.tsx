import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { mailColors, useAppearance } from "~/lib/appearance";
import { csp, hasOwnColors, hasRemoteContent } from "~/lib/mail";

function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (window.unicaDesktop) window.unicaDesktop.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

const MAX_HEIGHT = 20000;

/**
 * Renders an HTML email in a sandboxed iframe: sanitized with DOMPurify, no
 * scripts (sandbox without allow-scripts), strict CSP, links opened externally.
 * allow-same-origin (without scripts) only lets the parent measure the height.
 */
export function HtmlBody({ html, remoteImages, localMode, appearance }: { html: string; remoteImages: "ask" | "always"; localMode: boolean; appearance: "auto" | "paper" }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [userAllowed, setAllowRemote] = useState(remoteImages === "always");
  // local mode: remote content is never loaded, whatever the setting or a click says
  const allowRemote = userAllowed && !localMode;
  const [height, setHeight] = useState(120);
  const blocked = !allowRemote && hasRemoteContent(html);
  // re-rendered when the painted theme changes (the colors are literals inside the document)
  const themeKey = useAppearance((s) => s.themeKey);
  const mode = useAppearance((s) => s.mode);
  const clean = useMemo(() => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ["style"], FORBID_ATTR: ["srcset"], ADD_ATTR: ["target"] }), [html]);
  const paper = appearance === "paper" || hasOwnColors(clean);
  const doc = useMemo(() => {
    const c = mailColors()[paper ? "paper" : "themed"];
    // the CSP is unchanged by theming: local mode keeps the strict policy (allowRemote is false there)
    return `<!doctype html><html data-mail="${paper ? "paper" : "themed"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allowRemote)}"><base target="_blank"><style>html{overflow-y:hidden}html,body{margin:0;padding:0;background:${c.bg};color:${c.fg};font:14px/1.55 -apple-system,BlinkMacSystemFont,"Geist Variable",sans-serif;overflow-wrap:anywhere;color-scheme:${paper ? "light" : mode}}body{padding:16px}img{max-width:100%;height:auto}a{color:${c.link}}table{max-width:100%}</style></head><body>${clean}</body></html>`;
  }, [clean, allowRemote, paper, themeKey, mode]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const onLoad = () => {
      const d = frame.contentDocument;
      if (!d) return;
      // the frame is sized to its content, so it never scrolls inside. The box (not scrollHeight, which
      // never drops below the frame and rounds down) shrinks back and covers fractional heights.
      const measure = () => {
        const content = Math.ceil(d.documentElement.getBoundingClientRect().height);
        // past the cap the document scrolls: hidden content would be unreachable
        d.documentElement.style.overflowY = content > MAX_HEIGHT ? "auto" : "";
        setHeight(Math.min(MAX_HEIGHT, content));
      };
      measure();
      new ResizeObserver(measure).observe(d.documentElement);
      d.addEventListener("click", (e) => {
        const a = (e.target as Element).closest("a");
        if (a?.href) {
          e.preventDefault();
          openLink(a.href);
        }
      });
    };
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [doc]);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {blocked && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground" data-testid="remote-blocked">
          <ImageOff className="size-3.5" />
          {localMode ? "Contenido remoto bloqueado por el modo local." : "Contenido remoto bloqueado para proteger tu privacidad."}
          {!localMode && (
            <button type="button" className="ml-auto font-medium text-primary hover:underline" onClick={() => setAllowRemote(true)}>
              Cargar imágenes
            </button>
          )}
        </div>
      )}
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
          <button type="button" onClick={() => setShowQuoted((v) => !v)} className="mt-2 block rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground hover:text-foreground" aria-label="Mostrar texto citado">
            •••
          </button>
          {showQuoted && <div className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">{render(quoted)}</div>}
        </>
      )}
    </div>
  );
}
