import type { AttachmentInfo } from "@terno/core";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { t } from "@terno/i18n";
import { mailColors, useAppearance } from "~/lib/appearance";
import { csp, hasOwnColors, hasRemoteContent } from "~/lib/mail";
import { splitTextQuote } from "~/lib/quote";
import { forwardPrintKey, wantsNativeMenu } from "~/lib/print-open";
import { forwardUnreadKey } from "~/lib/unread";
import { forwardMouseNav, forwardNavKey } from "~/lib/page";
import { allowRemoteFor, remoteAllowed, useRemoteConsent } from "~/lib/remote-consent";

export function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (window.ternoDesktop) window.ternoDesktop.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

const MAX_HEIGHT = 20000;
const WEB = import.meta.env.VITE_TARGET === "web";

/** The last measured height of each message's frame: an expanding message opens to it, not to a guess. */
const heights = new Map<number, number>();
const HEIGHTS_MAX = 500;
function rememberHeight(key: number, h: number) {
  heights.delete(key);
  heights.set(key, h);
  if (heights.size > HEIGHTS_MAX) heights.delete(heights.keys().next().value!);
}

/**
 * Renders an HTML email in a sandboxed iframe: sanitized with DOMPurify, no
 * scripts (sandbox without allow-scripts), strict CSP, links opened externally.
 * allow-same-origin (without scripts) only lets the parent measure the height.
 */
export function HtmlBody({ html, messageId, remoteImages, appearance, attachments = [], accountId }: { attachments?: AttachmentInfo[]; accountId?: number; html: string; messageId: number; remoteImages: "ask" | "always"; appearance: "auto" | "paper" }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // the setting or this message's "Load content", in either mode (plan 37)
  const allowRemote = useRemoteConsent((s) => remoteAllowed(messageId, { remoteImages }, s.allowed));
  const [height, setHeight] = useState(() => heights.get(messageId) ?? 120);
  // re-rendered when the painted theme changes (the colors are literals inside the document)
  const themeKey = useAppearance((s) => s.themeKey);
  const mode = useAppearance((s) => s.mode);
  const clean = useMemo(() => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ["style"], FORBID_ATTR: ["srcset"], ADD_ATTR: ["target"] }), [html]);
  // read from what the frame gets (parsed once per message, not per render)
  const remote = useMemo(() => hasRemoteContent(clean, WEB), [clean]);
  const blocked = !allowRemote && remote;
  const [cidAllowed, setCidAllowed] = useState(false);
  const [cidResult, setCidResult] = useState<{ key: string; html: string } | null>(null);
  const cidKey = `${html}\0${attachments.map((a) => `${a.assetId}:${a.contentId}`).join("|")}`;
  const hasCid = /\bsrc\s*=\s*["']?cid:/i.test(html);
  useEffect(() => {
    if (!cidAllowed || accountId === undefined) return;
    let active = true;
    void import("~/lib/cid").then(({ resolveCidHtml }) => active ? resolveCidHtml(clean, accountId, attachments, () => active) : clean).then((html) => { if (active) setCidResult({ key: cidKey, html }); });
    return () => { active = false; };
  }, [cidAllowed, accountId, cidKey, clean]);
  const visibleHtml = cidAllowed && cidResult?.key === cidKey ? cidResult.html : clean;
  const paper = appearance === "paper" || hasOwnColors(clean);
  const doc = useMemo(() => {
    const c = mailColors()[paper ? "paper" : "themed"];
    // the CSP is unchanged by theming
    return `<!doctype html><html data-mail="${paper ? "paper" : "themed"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allowRemote)}"><base target="_blank"><style>html{overflow-y:hidden}html,body{margin:0;padding:0;background:${c.bg};color:${c.fg};font:14px/1.55 -apple-system,BlinkMacSystemFont,"Geist Variable",sans-serif;overflow-wrap:anywhere;color-scheme:${paper ? "light" : mode}}body{padding:${paper ? "16px" : "0"}}img{max-width:100%;height:auto}a{color:${c.link}}table{max-width:100%}</style></head><body>${visibleHtml}</body></html>`;
  }, [visibleHtml, allowRemote, paper, themeKey, mode]);

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
        rememberHeight(messageId, h);
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
      // a right-click inside the mail doesn't leave its frame: replayed on the frame, where the message's menu listens
      const onMenu = (e: MouseEvent) => {
        if (wantsNativeMenu(e.target, d.getSelection()?.toString() ?? "")) return;
        e.preventDefault();
        const r = frame.getBoundingClientRect();
        frame.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + e.clientX, clientY: r.top + e.clientY, button: 2 }));
      };
      d.addEventListener("click", onClick);
      d.addEventListener("contextmenu", onMenu);
      d.addEventListener("keydown", forwardPrintKey);
      d.addEventListener("keydown", forwardUnreadKey);
      // plan 24: Back from List's page (Esc, ⌘[, the mouse's side buttons) works with focus in the mail too
      d.addEventListener("keydown", forwardNavKey);
      d.addEventListener("mouseup", forwardMouseNav, true);
      detach = () => {
        d.removeEventListener("click", onClick);
        d.removeEventListener("contextmenu", onMenu);
        d.removeEventListener("keydown", forwardPrintKey);
        d.removeEventListener("keydown", forwardUnreadKey);
        d.removeEventListener("keydown", forwardNavKey);
        d.removeEventListener("mouseup", forwardMouseNav, true);
      };
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
      {hasCid && !cidAllowed && <button type="button" data-testid="inline-load" className="mb-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => setCidAllowed(true)}>{t("attachments.loadInline")}</button>}
      {blocked && <RemoteBlocked onLoad={() => allowRemoteFor(messageId)} />}
      {/* themed mail flows on the page with no box; mail with its own colors keeps a borderless paper surface */}
      <div className={paper ? "overflow-hidden rounded-lg bg-[var(--mail-paper)]" : undefined}>
        <iframe
          ref={ref}
          title={t("reader.mailContent")}
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

/** The remote-content row: a full-width tinted row with a pill on the right. */
function RemoteBlocked({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="mb-3 flex h-9 items-center gap-2.5 rounded-lg bg-tint pr-1.5 pl-3 text-xs text-muted-foreground" data-testid="remote-blocked">
      <ImageOff className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("reader.remote.blocked")}</span>
      <button type="button" className="ml-auto h-[22px] shrink-0 rounded-full bg-accent px-2.5 text-[11.5px] font-medium text-accent-foreground transition-colors hover:text-foreground" onClick={onLoad} data-testid="remote-load">
        {t("reader.remote.load")}
      </button>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/** Plain-text body: trailing quoted history folded, links clickable. */
export function TextBody({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = splitTextQuote(text);
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
    <div className="type-body whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
      {render(main)}
      {quoted && (
        <>
          <button type="button" onClick={() => setShowQuoted((v) => !v)} className="mt-2 block rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground hover:text-foreground" aria-label={showQuoted ? t("reader.quote.hide") : t("reader.quote.show")} aria-expanded={showQuoted}>
            •••
          </button>
          {showQuoted && <div className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">{render(quoted)}</div>}
        </>
      )}
    </div>
  );
}
