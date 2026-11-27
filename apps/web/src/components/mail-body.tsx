import { cidImageSources, type AttachmentInfo, type MatchNeedle } from "@terno/core";
import DOMPurify from "dompurify";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameHeight, rememberHeight } from "~/lib/frame-heights";
import { createPortal, flushSync } from "react-dom";
import FullMessage from "./full-message";
import { FullMessageBoundary, useMailReaderView } from "./mail-reader-view";
import { resolveCidHtml } from "~/lib/cid";
import { Button } from "@terno/ui/components/button";
import { ChevronRight, ImageOff } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { READ_MAX_CSS, READ_MEASURE } from "~/lib/pane-lines";
import { t } from "@terno/i18n";
import { mailColors, useAppearance } from "~/lib/appearance";
import { csp, hasRemoteContent, mailDesign, QUIET_ATTR } from "~/lib/mail";
import { darkenMail, darkenPictures } from "~/lib/mail-dark";
import { showOriginal, useMailOriginal } from "~/lib/mail-original";
import { splitTextQuote } from "~/lib/quote";
import { withoutTrailingQuote } from "~/lib/quote-html";
import { forwardPrintKey, ownsLinkMenu, wantsNativeMenu } from "~/lib/print-open";
import { forwardMouseNav, forwardNavKey } from "~/lib/page";
import { chooseOpenThread } from "~/state/app";
import { allowRemoteFor, remoteAllowed, useRemoteConsent } from "~/lib/remote-consent";
import { FRAME_MAX_HEIGHT, htmlHolds, MAIL_INTERACTION, markDocument, markTextParts, marksChanged, textHolds } from "~/lib/reader-marks";
import { Marked } from "./match-mark";

import { openLink } from "~/lib/open-link";
import { linkAt, menuLink } from "~/lib/menu-link";
import { replayMenu } from "~/lib/menu-origin";
export { openLink };

const MAX_HEIGHT = FRAME_MAX_HEIGHT;
const WEB = import.meta.env.VITE_TARGET === "web";

/**
 * The reader's own sanitizer. On desktop its pictures are fetched in CORS mode (no cookies go with them), and main lets a
 * mail frame read them (plan 295: a darkened mail reads its logos' pixels); printing and the rest keep the shared instance.
 */
const purify = DOMPurify(window);
if (!WEB) purify.addHook("afterSanitizeAttributes", (node) => { if (node.nodeName === "IMG") node.setAttribute("crossorigin", "anonymous"); });


/**
 * Renders an HTML email in a sandboxed iframe: sanitized with DOMPurify, no
 * scripts (sandbox without allow-scripts), strict CSP, links opened externally.
 * allow-same-origin (without scripts) only lets the parent measure the height.
 */
interface MailLook {
  /** plan 295: "dark" is a designed mail rewritten onto the dark theme's colors, flowing on the page like themed mail */
  mail: "paper" | "themed" | "dark";
  /** the root's custom properties */
  vars: Record<string, string>;
  /** the same, as a style attribute for the document's first paint */
  style: string;
}

/** A mail document's colors, scheme and padding for the painted theme. */
function mailLook(mail: MailLook["mail"], mode: string): MailLook {
  const paper = mail === "paper";
  const c = mailColors()[paper ? "paper" : "themed"];
  const vars = { "--m-bg": c.bg, "--m-fg": c.fg, "--m-quiet": c.quiet, "--m-link": c.link, "--m-mark": c.mark, "--m-scheme": paper ? "light" : mode, "--m-pad": paper ? "16px" : "0" };
  return { mail, vars, style: Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";") };
}

/** Which look a mail gets: darkened, on paper (the setting, or a designed mail left as written), or themed. */
function lookOf(dark: boolean, appearance: "auto" | "paper", ownColors: boolean, mode: string): MailLook {
  return mailLook(dark ? "dark" : appearance === "paper" || ownColors ? "paper" : "themed", mode);
}

/**
 * Plan 295: on desktop a picture is asked for in CORS mode (`purify`); one that fails that way (a server refusing it)
 * is asked for again the ordinary way, so a picture never goes missing for being readable.
 */
function plainAgain(event: Event): void {
  const img = event.target as Element | null;
  // (changing the attribute is enough: the picture is fetched again, without CORS)
  if (img?.nodeName === "IMG" && img.hasAttribute("crossorigin")) img.removeAttribute("crossorigin");
}

/**
 * Plan 295: what a loaded mail gets in a dark theme. "dark": a designed mail rewritten onto the theme's colors, and its
 * pictures read; "pictures": a themed mail (already on the dark page) has only its pictures read, so a dark logo never
 * vanishes; "none": as it is.
 */
type DarkWork = "dark" | "pictures" | "none";

/**
 * Does `work` on the loaded mail, undoing the last first (so a palette change converts from the colors as written).
 * True when the mail is darkened.
 */
function convert(flow: HTMLElement, work: DarkWork, current: { current: (() => void) | null }): boolean {
  current.current?.();
  current.current = null;
  if (work === "none") return false;
  const { themed, paper } = mailColors();
  const result = work === "dark" ? darkenMail(flow, { background: themed.bg, card: themed.card, foreground: themed.fg, muted: themed.quiet, link: themed.link, border: themed.border }) : null;
  if (result && !result.converted) return false;
  const pictures = darkenPictures(flow, paper.bg, themed.bg);
  current.current = () => { pictures(); if (result?.converted) result.undo(); };
  return result !== null;
}

/** Repaints the loaded document without replacing its own style properties. */
function paint(root: HTMLElement, look: MailLook): void {
  for (const [k, v] of Object.entries(look.vars)) root.style.setProperty(k, v);
  root.dataset.mail = look.mail;
}

export interface HtmlBodyProps { /** plan 158: a search's words, marked in the loaded mail */ marks?: readonly MatchNeedle[]; attachments?: AttachmentInfo[]; accountId?: number; html: string; messageId: number; /** spam never loads on its own, whatever the setting */ spam?: boolean; remoteImages: "ask" | "always"; appearance: "auto" | "paper"; section?: boolean; onExit?: () => void; onSectionHeight?: (height: number) => boolean; hydrate?: (doc: Document, signal: AbortSignal) => Promise<void>; onHydrationError?: () => void; /** plan 188: the frame's name, whose message it is ("Message from Ana, …"); else "Message content" */ label?: string }

export function HtmlBody({ marks, html, messageId, remoteImages, spam = false, appearance, attachments = [], accountId, section = false, onExit, onSectionHeight, hydrate, onHydrationError, label }: HtmlBodyProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loaded = useRef<{ markup: string; doc: Document; tabs: WeakMap<Node, string | null> } | null>(null);
  const hydrateRef = useRef(hydrate);
  const errorRef = useRef(onHydrationError);
  useLayoutEffect(() => { hydrateRef.current = hydrate; errorRef.current = onHydrationError; }, [hydrate, onHydrationError]);
  const heightRef = useRef(onSectionHeight);
  useLayoutEffect(() => { heightRef.current = onSectionHeight; }, [onSectionHeight]);
  const exitRef = useRef(onExit);
  useLayoutEffect(() => { exitRef.current = onExit; }, [onExit]);
  const marksRef = useRef(marks);
  const view = useMailReaderView();
  const closeView = view?.close;
  const [opening, setOpening] = useState(0);
  const lease = useMemo(() => ({}), [html, messageId, accountId, attachments.map((a) => `${a.assetId}:${a.contentId}`).join("|")]);
  const [clipping, setClipping] = useState({ source: "", clipped: false });
  const [copiedText, setCopiedText] = useState<string | null>(null);
  useEffect(() => { if (view?.active !== lease) setCopiedText(null); }, [view?.active, lease]);
  useLayoutEffect(() => () => closeView?.(lease, false), [lease, closeView]);
  // the setting or this message's "Load content", in either mode (plan 37)
  const allowRemote = useRemoteConsent((s) => remoteAllowed(messageId, { remoteImages, spam }, s.allowed));
  const [height, setHeight] = useState(() => section ? 120 : frameHeight(messageId) ?? 120);
  // until its first height is on it, the frame shows nothing, never a slice of the mail (a rebuild keeps the frame shown)
  const [shown, setShown] = useState(section);
  // re-rendered when the painted theme changes (the colors are literals inside the document)
  const themeKey = useAppearance((s) => s.themeKey);
  const mode = useAppearance((s) => s.mode);
  const sanitized = useMemo(() => purify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ["style"], FORBID_ATTR: ["srcset"], ADD_ATTR: ["target"] }), [html]);
  // plan 158: a designed mail keeps its colors on paper; a simple one takes the theme's, its grey text marked quiet
  // (a section of the full-message view: its paper or theme is the caller's, from the whole mail; its quiet text still marked)
  const design = useMemo(() => mailDesign(sanitized), [sanitized]);
  const clean = design.html;
  // one rule for quoted history, in text and in HTML: a trailing block is folded behind the same control
  const [quoteShown, setQuoteShown] = useState(false);
  const main = useMemo(() => (section ? null : withoutTrailingQuote(clean)), [clean, section]);
  const folded = main !== null && !quoteShown;
  // plan 158: the only match is in the folded history: it opens, or the search would seem wrong
  useEffect(() => {
    if (marks?.length && folded && !htmlHolds(main, marks) && htmlHolds(clean, marks)) setQuoteShown(true);
  }, [marks, clean]);
  // read from what the frame gets (parsed once per message, not per render)
  const remote = useMemo(() => hasRemoteContent(folded ? main : clean, WEB), [clean, main, folded]);
  const blocked = !allowRemote && remote;
  const [cidAllowed, setCidAllowed] = useState(false);
  const [cidResult, setCidResult] = useState<{ key: string; html: string } | null>(null);
  const cidKey = `${accountId}\0${html}\0${attachments.map((a) => `${a.assetId}:${a.contentId}`).join("|")}`;
  // plan 220: also by the reading that lists its pictures, so one left out of the files is always offered here
  const hasCid = useMemo(() => /\bsrc\s*=\s*["']?cid:/i.test(html) || cidImageSources(html).length > 0, [html]);
  useEffect(() => {
    if (!cidAllowed || accountId === undefined) return;
    let active = true;
    void resolveCidHtml(clean, accountId, attachments, () => active).then((html) => { if (active) setCidResult({ key: cidKey, html }); });
    return () => { active = false; };
  }, [cidAllowed, accountId, cidKey, clean]);
  const resolved = cidAllowed && cidResult?.key === cidKey ? cidResult.html : clean;
  const visibleHtml = useMemo(() => (!folded ? resolved : resolved === clean ? main : (withoutTrailingQuote(resolved) ?? resolved)), [resolved, clean, main, folded]);
  const ownColors = !section && design.designed;
  // plan 295: in a dark theme, "Match theme" rewrites a designed mail onto the theme's colors, unless the mail is better on
  // its paper (the converter says) or the reader asked for the original
  const original = useMailOriginal((s) => s.shown.has(messageId));
  const offerDark = ownColors && appearance === "auto" && mode === "dark";
  const wantDark = offerDark && !original;
  // a themed mail is on the dark page already: only its pictures are read
  const work: DarkWork = section || mode !== "dark" ? "none" : wantDark ? "dark" : !ownColors && appearance === "auto" ? "pictures" : "none";
  // whether the loaded document is darkened: decided on it, when it loads and when the above changes
  const [darkened, setDarkened] = useState(false);
  const paper = appearance === "paper" || (ownColors && !darkened);
  // a designed mail keeps its own layout; anything else wraps at the reader's measure, while its pictures and fixed tables keep the frame's width
  const measured = !section && !ownColors;
  // the colors, as variables on the document's root: a theme or "HTML mail" change repaints the loaded mail in place
  // (themeKey: the painted palette, read by mailLook)
  const look = useMemo(() => lookOf(darkened, appearance, ownColors, mode), [darkened, appearance, ownColors, themeKey, mode]);
  // what a document that loads is converted and painted with (read in its load, outside render)
  const loadWith = useRef({ work, appearance, ownColors, mode });
  useLayoutEffect(() => { loadWith.current = { work, appearance, ownColors, mode }; });
  const darkUndo = useRef<(() => void) | null>(null);
  // the loaded document's measure, for a repaint that changes its geometry (paper's padding, plan 295)
  const measureRef = useRef<(() => void) | null>(null);
  // the document is rebuilt only when what it shows changes (the mail, its remote content); its first paint has the
  // colors of that moment. A rebuild reloads the frame (blank, then re-measured): theming must never cause one.
  const [built, setBuilt] = useState({ html: visibleHtml, allowRemote, look });
  if (built.html !== visibleHtml || built.allowRemote !== allowRemote) setBuilt({ html: visibleHtml, allowRemote, look });
  const version = useRef(0);
  const sourceId = useMemo(() => String(++version.current), [built]);
  // a search's mark: the tint under the mail's own ink, weight as well as color; the one in hand outlined (no color of its own, so it holds on any mail)
  const markStyle = "mark[data-reader-match]{background:color-mix(in srgb,var(--m-mark) 30%,transparent);color:inherit;font-weight:600;border-radius:2px}mark[data-reader-current]{outline:1.5px solid var(--m-mark)}";
  // a simple mail in the theme's colors: its greys and white page give way to the theme's ink, quiet ink and page, its links to the theme's link
  // (and no picture or gradient behind: a simple mail has none, and a darkened mail's full view would put the theme's ink on them)
  // (keyed on the root's data-mail, so "Always paper" shows it as written, without a rebuild)
  const themedStyle = `html[data-mail=themed] [data-terno-flow] *:not(:where(mark[data-reader-match])){color:inherit!important;background-color:transparent!important;background-image:none!important}html[data-mail=themed] [data-terno-flow] a,html[data-mail=themed] [data-terno-flow] a *{color:var(--m-link)!important}html[data-mail=themed] [data-terno-flow] [${QUIET_ATTR}]{color:var(--m-quiet)!important}`;
  const doc = useMemo(
    () =>
      `<!doctype html><html data-mail="${built.look.mail}" style="${built.look.style}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(built.allowRemote)}"><base target="_blank"><style>${section ? themedStyle : markStyle + themedStyle}${measured ? `[data-terno-flow]{max-width:${READ_MAX_CSS}}[data-terno-flow] img,[data-terno-flow] table{max-width:100vw}` : ""}html{overflow-y:clip}html,body{margin:0;padding:0;background:var(--m-bg);color:var(--m-fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Geist Variable",sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-wrap:anywhere;color-scheme:var(--m-scheme)}body{padding:var(--m-pad);${section ? "" : "max-height:20000px;overflow:clip;box-sizing:border-box;position:relative;contain:paint"}}[data-terno-flow]{display:flow-root}img{max-width:100%;height:auto}a{color:var(--m-link)}table{max-width:100%}${section ? "body{padding:0}body *:not(svg,svg *){position:static!important;float:none!important;transform:none!important;zoom:1!important;writing-mode:horizontal-tb!important;height:auto!important;min-height:0!important;max-height:none!important;min-width:0!important;max-width:100%!important;margin:0!important;padding:0!important;border-width:0!important;border-spacing:0!important;text-indent:0!important;letter-spacing:normal!important;word-spacing:normal!important;overflow:visible!important;font-size:14px!important;line-height:1.55!important;overflow-wrap:anywhere!important;white-space:pre-wrap!important}body img,body svg,body video,body canvas,body input,body select{max-width:100%!important;max-height:2048px!important;object-fit:contain}body table{table-layout:auto}" : ""}</style></head><body><div data-terno-flow data-terno-document="${sourceId}">${built.html}</div></body></html>`,
    [built, section, sourceId, measured],
  );
  const source = useCallback((signal: AbortSignal) => new Promise<{ root: HTMLElement; tabs: WeakMap<Node, string | null> }>((resolve, reject) => {
    const frame = ref.current;
    const cleanup = () => { frame?.removeEventListener("load", check); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const check = () => {
      const current = loaded.current;
      const root = current?.doc.querySelector<HTMLElement>("[data-terno-flow]");
      if (root && current?.markup === sourceId && current.doc === frame?.contentDocument) { cleanup(); resolve({ root, tabs: current.tabs }); }
    };
    if (signal.aborted) { abort(); return; }
    frame?.addEventListener("load", check); signal.addEventListener("abort", abort, { once: true }); check();
    // (a conversion done or undone while the full view is open: it prepares again from the colors now on the mail)
  }), [sourceId, darkened]);
  // the loaded document follows the colors (and gets them again once a rebuilt one loads)
  const lookRef = useRef(look);
  useEffect(() => {
    lookRef.current = look;
    const root = ref.current?.contentDocument?.documentElement;
    if (!root) return;
    paint(root, look);
    // paper's padding comes and goes with the look: the frame's height follows (its observer watches a viewport that doesn't change)
    measureRef.current?.();
  }, [look]);

  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // everything attached to the loaded document goes when the document or the frame does
    let active = true;
    let observer: ResizeObserver | null = null;
    let detach: (() => void) | null = null;
    let hydration: AbortController | null = null;
    let setUp: Document | null = null;
    let parsing = 0;
    const onLoad = () => {
      const d = frame.contentDocument;
      const flow = d?.querySelector<HTMLElement>("[data-terno-flow]");
      // (once a document: when it's parsed, or at its load if that comes first; never the outgoing one, whose late load
      // can land after a rebuild was asked for)
      if (!d || !flow || d === setUp || flow.dataset.ternoDocument !== sourceId) return;
      setUp = d;
      hydration?.abort();
      observer?.disconnect();
      detach?.();
      const finish = () => {
        if (!active || frame.contentDocument !== d || !flow.isConnected) return;
        // plan 295: converted (or not) before anything is measured or shown, so a darkened mail never flashes its paper
        darkUndo.current = null;
        const now = loadWith.current;
        const dark = convert(flow, now.work, darkUndo);
        lookRef.current = lookOf(dark, now.appearance, now.ownColors, now.mode);
        paint(d.documentElement, lookRef.current);
        flushSync(() => setDarkened(dark));
        // (counted, and scrolled to, once the height measured below is on the frame)
        if (!section && marksRef.current?.length) {
          markDocument(flow, marksRef.current);
          requestAnimationFrame(marksChanged);
        }
        const tabStops = section ? [] : [...d.querySelectorAll<HTMLElement>("a[href], area[href], button, input, select, textarea, [tabindex]")].map((element) => ({ element, tab: element.getAttribute("tabindex") }));
        loaded.current = { markup: flow.dataset.ternoDocument!, doc: d, tabs: new WeakMap(tabStops.map(({ element, tab }) => [element, tab])) };
        const styled = [...d.body.querySelectorAll<HTMLElement>(section ? "[style]:not(svg *)" : "[style]")];
        const positioned = styled.filter((element) => ["absolute", "fixed"].includes(getComputedStyle(element).position));
        const cropped = styled.filter((element) => {
          const overflow = getComputedStyle(element).overflowY;
          if (overflow === "auto" || overflow === "scroll") element.style.setProperty("overflow-y", "clip", "important");
          return overflow === "hidden" || overflow === "clip" || overflow === "auto" || overflow === "scroll";
        });
        // Reserve media growth before displaying a section, so late loads/width changes
        // cannot force repartitioning underneath a native text selection.
        const mediaAllowance = section ? d.querySelectorAll("img:not(svg *),svg:not(svg *),video:not(svg *),canvas:not(svg *),input:not(svg *),select:not(svg *)").length * 4096 : 0;
        const clippedParents = new Set(cropped);
        const disabledStops = new Map<HTMLElement, string | null>();
        let sized = false;
        // Measure the flow independently of the preview box, including positioned overflow.
        // Reset that box first so changed bodies and image reflows can shrink; round up fractional pixels.
        const measure = () => {
          if (!active || frame.contentDocument !== d || !flow.isConnected) return;
          if (!section) d.body.style.height = "auto";
          const padding = getComputedStyle(d.body);
          const content = Math.ceil(Math.max(Math.max(flow.getBoundingClientRect().height, flow.scrollHeight) + Number.parseFloat(padding.paddingTop) + Number.parseFloat(padding.paddingBottom), d.body.scrollHeight, positioned.reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), 0)));
          if (section && heightRef.current?.(content + mediaAllowance) === false) { setHeight(120); return; }
          if (!section) d.body.style.height = `${Math.min(MAX_HEIGHT, content)}px`;
          const clipped = !section && (content > MAX_HEIGHT || cropped.some((element) => element.scrollHeight > element.clientHeight));
          setClipping((previous) => previous.source === clean && previous.clipped === clipped ? previous : { source: clean, clipped });
          if (!section && clipped) {
            const boxes = new Map<HTMLElement, DOMRect>();
            for (const { element, tab } of tabStops) {
              const rect = element.getBoundingClientRect();
              let hidden = rect.top >= MAX_HEIGHT;
              for (let parent = element.parentElement; !hidden && parent; parent = parent.parentElement) {
                if (!clippedParents.has(parent)) continue;
                let box = boxes.get(parent);
                if (!box) { box = parent.getBoundingClientRect(); boxes.set(parent, box); }
                hidden = rect.top >= box.bottom;
              }
              if (hidden) { element.setAttribute("tabindex", "-1"); disabledStops.set(element, tab); }
              else if (disabledStops.has(element)) {
                if (tab === null) element.removeAttribute("tabindex"); else element.setAttribute("tabindex", tab);
                disabledStops.delete(element);
              }
            }
          } else if (!section) {
            for (const [element, tab] of disabledStops) { if (tab === null) element.removeAttribute("tabindex"); else element.setAttribute("tabindex", tab); }
            disabledStops.clear();
          }
          const h = section ? content : Math.min(MAX_HEIGHT, content);
          // (folded only: a frame opens folded, and opening at an unfolded height would shrink as it measures)
          if (!section && !quoteShown) rememberHeight(messageId, h);
          // a document's first height lands in the paint that shows it, so the mail appears whole
          if (!section && !sized) { sized = true; flushSync(() => { setHeight(h); setShown(true); }); } else setHeight(h);
        };
        measure();
        measureRef.current = measure;
        d.addEventListener("load", measure, true);
        observer = new ResizeObserver(measure);
        observer.observe(d.documentElement);
        const onClick = (e: MouseEvent) => {
          const a = (e.target as Element).closest("a");
          if (a?.href) {
            e.preventDefault();
            openLink(a.href);
          }
        };
        // a right-click inside the mail doesn't leave its frame: replayed on the frame, where the message's menu listens (with
        // what it was on: a link has its own items, plan 284)
        const onMenu = (e: MouseEvent) => {
          if (wantsNativeMenu(e.target, d.getSelection()?.toString() ?? "")) return;
          e.preventDefault();
          const r = frame.getBoundingClientRect();
          replayMenu(frame, e.target as Element, r.left + e.clientX, r.top + e.clientY);
        };
        if (!WEB) {
          d.addEventListener("error", plainAgain, true);
          // (and one that failed before this: a quick refusal can beat the document's setup)
          for (const img of d.images) if (img.complete && !img.naturalWidth && img.hasAttribute("crossorigin") && img.getAttribute("src")) img.removeAttribute("crossorigin");
        }
        d.addEventListener("click", onClick);
        d.addEventListener("contextmenu", onMenu);
        d.addEventListener("keydown", forwardPrintKey);
        // plan 24: Back from List's page (Esc, ⌘[, the mouse's side buttons) works with focus in the mail too
        const onNavKey = (event: KeyboardEvent) => {
          if (section && event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
            event.preventDefault(); event.stopImmediatePropagation(); exitRef.current?.();
          } else if (event.key === "F6" && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // plan 188 (Codex review): F6 between the panes with focus in the mail too; the frame keeps it if nothing moved
            const forwarded = new KeyboardEvent("keydown", { key: "F6", shiftKey: event.shiftKey, bubbles: true, cancelable: true });
            document.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) event.preventDefault();
          } else if ((event.key === "F10" && event.shiftKey || event.key === "ContextMenu") && !event.metaKey && !event.ctrlKey && !event.altKey && ownsLinkMenu(linkAt(d.activeElement))) {
            // plan 284: the menu key on a link in the mail opens the conversation's menu with the link's items (openFocusedMenu);
            // anywhere else in the mail it's the frame's own (never the list's menu), as a page's link on the web is the browser's
            const forwarded = new KeyboardEvent("keydown", { key: event.key, shiftKey: event.shiftKey, bubbles: true, cancelable: true });
            document.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) event.preventDefault();
          } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g") {
            // plan 158: the next and previous match with focus in the mail too (the frame's keys stop at its document)
            event.preventDefault();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey }));
          } else forwardNavKey(event);
        };
        d.addEventListener("keydown", onNavKey);
        d.addEventListener("mouseup", forwardMouseNav, true);
        // a press in the mail is a press in the reader (its own capture never sees this document)
        d.addEventListener("pointerdown", chooseOpenThread, true);
        // and a wheel, a key or a press here is the user's hand on the reader: a search's first match stops being shown again
        const interacted = () => { frame.dispatchEvent(new Event(MAIL_INTERACTION, { bubbles: true })); };
        for (const type of ["wheel", "keydown", "pointerdown"]) d.addEventListener(type, interacted, { capture: true, passive: true });
        detach = () => {
          if (measureRef.current === measure) measureRef.current = null;
          for (const type of ["wheel", "keydown", "pointerdown"]) d.removeEventListener(type, interacted, true);
          d.removeEventListener("pointerdown", chooseOpenThread, true);
          d.removeEventListener("load", measure, true);
          d.removeEventListener("error", plainAgain, true);
          d.removeEventListener("click", onClick);
          d.removeEventListener("contextmenu", onMenu);
          d.removeEventListener("keydown", forwardPrintKey);
          d.removeEventListener("keydown", onNavKey);
          d.removeEventListener("mouseup", forwardMouseNav, true);
        };
      };
      if (section && hydrateRef.current) {
        hydration = new AbortController();
        const cancellation = hydration;
        void hydrateRef.current(d, cancellation.signal).then(finish, () => { if (!cancellation.signal.aborted) errorRef.current?.(); });
      } else finish();
    };
    frame.addEventListener("load", onLoad);
    // a mail (or a full message's section, its media room reserved) is measured once its document is parsed, not when its
    // pictures arrive (the frame's load waits for each one); a few frames at most, until the new document is in (it
    // replaces the old one asynchronously) or the load comes first
    const parsed = () => {
      const d = frame.contentDocument;
      if (d?.querySelector<HTMLElement>("[data-terno-flow]")?.dataset.ternoDocument === sourceId && d.readyState !== "loading") onLoad();
      else parsing = requestAnimationFrame(parsed);
    };
    parsing = requestAnimationFrame(parsed);
    return () => {
      active = false;
      cancelAnimationFrame(parsing);
      hydration?.abort();
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      detach?.();
    };
  }, [doc, section, sourceId]);

  // plan 295: the theme, the setting or "Show original" changed under a loaded mail: converted again (or put back) in place
  useEffect(() => {
    const current = loaded.current;
    const flow = current && current.doc === ref.current?.contentDocument ? current.doc.querySelector<HTMLElement>("[data-terno-flow]") : null;
    if (!flow) return;
    setDarkened(convert(flow, work, darkUndo));
  }, [work, themeKey]);

  // a message folded away takes its marks with it
  useEffect(() => () => marksChanged(), []);
  // the search changed under a mail that's already loaded
  useEffect(() => {
    if (marksRef.current === marks) return;
    marksRef.current = marks;
    const flow = ref.current?.contentDocument?.querySelector<HTMLElement>("[data-terno-flow]");
    if (flow && !section) markDocument(flow, marks);
    marksChanged();
  }, [marks, section]);

  const inlineControl = hasCid && !cidAllowed && <button type="button" data-testid="inline-load" className="mb-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => setCidAllowed(true)}>{t("attachments.loadInline")}</button>;
  const remoteControl = blocked && <RemoteBlocked onLoad={() => allowRemoteFor(messageId)} />;
  return (
    <div>
      {!section && hasCid && !cidAllowed && <button type="button" data-testid="inline-load" className="mb-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => setCidAllowed(true)}>{t("attachments.loadInline")}</button>}
      {!section && blocked && <RemoteBlocked onLoad={() => allowRemoteFor(messageId)} />}
      {/* plan 295: a darkened mail can be seen as it was written, for the session */}
      {!section && offerDark && (darkened || original) && (
        <div className="mb-2 flex justify-end">
          <Button variant="link-secondary" size="xs" data-testid="mail-original" className="font-normal text-muted-foreground hover:text-foreground" onClick={() => showOriginal(messageId, !original)}>
            {t(original ? "reader.mail.matchTheme" : "reader.mail.showOriginal")}
          </Button>
        </div>
      )}
      {/* themed mail flows on the page with no box; mail with its own colors keeps a paper surface, its edge drawn so its inset reads as the sheet's, on paper-white pages too */}
      {/* (a mail that may darken shows no paper until its document has been converted and measured: never a light slab first) */}
      <div className={paper && (shown || !wantDark) ? "hairline overflow-hidden rounded-lg bg-[var(--mail-paper)] [--hairline-color:var(--border)]" : undefined}>
        <iframe
          ref={ref}
          title={label ?? t("reader.mailContent")}
          sandbox="allow-same-origin allow-popups"
          scrolling="no"
          srcDoc={doc}
          style={{ height, visibility: shown ? undefined : "hidden" }}
          data-mail={look.mail}
          className="block w-full border-0"
        />
      </div>
      {main !== null && <QuoteToggle open={quoteShown} onToggle={() => setQuoteShown((v) => !v)} />}
      {((clipping.source === clean && clipping.clipped) || (!section && view?.active === lease)) && <button type="button" className="mt-3 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2" onClick={(event) => {
        const original = ref.current?.contentDocument;
        const selection = original?.getSelection();
        // (parsed is enough: a picture still on its way doesn't hold the full message back)
        if (!original?.body || !selection || original.readyState === "loading") return;
        const previous = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
        try {
          const range = original.createRange(); range.selectNodeContents(original.body);
          selection.removeAllRanges(); selection.addRange(range);
          setCopiedText(selection.toString());
        } finally { selection.removeAllRanges(); for (const range of previous) selection.addRange(range); }
        setOpening((value) => value + 1); view?.open(lease, event.currentTarget);
      }}>{t("reader.full.show")}</button>}
      {view?.active === lease && view.target && createPortal(
        <FullMessageBoundary onClose={() => view.close(lease)} key={opening}>
          <FullMessage source={source} html={visibleHtml} messageId={messageId} accountId={accountId} attachments={attachments} remoteImages={remoteImages} appearance={paper ? "paper" : appearance} onClose={() => view.close(lease)} controls={<>{inlineControl}{remoteControl}</>} copyText={() => { if (copiedText === null) throw new Error("Message selection is not ready"); return copiedText; }} />
        </FullMessageBoundary>, view.target)}
    </div>
  );
}

/** The remote-content row: a line over the mail with a pill on the right (plan 160: a hairline under it, no card: it neither floats nor goes away by itself). */
function RemoteBlocked({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="hairline-b mb-3 flex h-9 items-center gap-2.5 text-xs text-muted-foreground" data-testid="remote-blocked">
      <ImageOff className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("reader.remote.blocked")}</span>
      <button type="button" className="ml-auto h-[22px] shrink-0 rounded-full bg-accent px-2.5 text-[11.5px] font-medium text-accent-foreground transition-colors hover:text-foreground" onClick={onLoad} data-testid="remote-load">
        {t("reader.remote.load")}
      </button>
    </div>
  );
}

/** Quoted history, folded: says what it holds and turns as it opens. The same in plain text and HTML mail. */
export function QuoteToggle({ open, onToggle, controls, testId = "quote-toggle", className }: { open: boolean; onToggle: () => void; controls?: string; testId?: string; className?: string }) {
  return (
    <Button type="button" variant="link-secondary" size="xs" onClick={onToggle} aria-expanded={open} aria-controls={controls} data-testid={testId} className={cn("mt-2 -ml-1 flex h-6 gap-1 font-normal text-foreground-soft hover:text-foreground hover:no-underline", className)}>
      <ChevronRight className={cn("size-3.5 transition-transform duration-base ease-motion", open && "rotate-90")} />
      {t(open ? "reader.quote.hide" : "reader.quote.show")}
    </Button>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/** Plain-text body: trailing quoted history folded, links clickable. */
export function TextBody({ text, marks }: { text: string; /** plan 158: a search's words */ marks?: readonly MatchNeedle[] }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = splitTextQuote(text);
  // the only match is in the folded history: it opens
  useEffect(() => {
    if (marks?.length && quoted && !textHolds(main, marks) && textHolds(quoted, marks)) setShowQuoted(true);
  }, [marks, text]);
  useLayoutEffect(() => {
    if (marks) marksChanged();
  }, [marks, showQuoted, text]);
  // a message folded away takes its marks with it
  useEffect(() => () => marksChanged(), []);
  // the whole body, links and the history shown included, is marked under one budget: a long mail repeating the words is
  // a few hundred marks, not one each (Codex series review)
  const pieces = useMemo(() => {
    const mainPieces = main.split(URL_RE), quotedPieces = quoted && showQuoted ? quoted.split(URL_RE) : [];
    const parts = markTextParts([...mainPieces, ...quotedPieces], marks);
    return { main: mainPieces.map((text, i) => ({ text, parts: parts[i] })), quoted: quotedPieces.map((text, i) => ({ text, parts: parts[mainPieces.length + i] })) };
  }, [main, quoted, showQuoted, marks]);
  const render = (list: readonly { text: string; parts: ReturnType<typeof markTextParts>[number] | undefined }[]) =>
    list.map(({ text: part, parts }, i) =>
      i % 2 ? (
        // ⇧F10 on it opens the conversation's menu with the link's items, as a right-click does (plan 284)
        <a key={i} href={part} data-context-menu={ownsLinkMenu(menuLink(part)) || undefined} className="text-primary underline-offset-2 hover:underline" onClick={(e) => (e.preventDefault(), openLink(part))}>
          <Marked text={part} needles={marks} parts={parts ?? null} testId="reader-match" body />
        </a>
      ) : (
        <Marked key={i} text={part} needles={marks} parts={parts ?? null} testId="reader-match" body />
      ),
    );
  return (
    // the measure: about 75 characters a line, in every style's body type
    <div data-testid="message-text" className={cn("type-body whitespace-pre-wrap", READ_MEASURE, "text-foreground [overflow-wrap:anywhere]")}>
      {render(pieces.main)}
      {quoted && (
        <>
          <QuoteToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />
          {showQuoted && <div className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">{render(pieces.quoted)}</div>}
        </>
      )}
    </div>
  );
}
