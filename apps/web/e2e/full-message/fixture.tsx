import { calls, PNG } from "./transport";
import { useApp } from "../../src/state/app";
import { useState } from "react";
import { Expand } from "../../src/components/expand";
import { PrintSheet } from "../../src/components/print-sheet";
import { ModalHostProvider } from "@terno/ui/components/modal-host";
import { createRoot } from "react-dom/client";
import { useAppearance } from "../../src/lib/appearance";
import { MailReaderView } from "../../src/components/mail-reader-view";
import { loadLocale } from "@terno/i18n";
import { installFocusRing } from "../../src/lib/focus-ring";
import "@terno/ui/styles/globals.css";
import { applyAppearance } from "../../src/lib/appearance";
import { ReaderFixture, prepareReaderFixture } from "./reader-fixture";
import { HtmlBody } from "../../src/components/mail-body";

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", dark);
useAppearance.setState({ mode: dark ? "dark" : "light" });

installFocusRing();
applyAppearance({ theme: dark ? "dark" : "light", design: "macos", lightTheme: "design", darkTheme: "design", motionMs: 0, customThemes: [] });
const params = new URLSearchParams(location.search);
const physical = params.has("physical");
const blocks = params.has("control") ? 2 : 40;
await loadLocale(params.has("es") ? "es" : "en");
const background = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="2048"><rect width="1" height="2048" fill="red"/></svg>');
const deep = () => '<div style="height:30000px"></div>' + Array.from({ length: 8 }, (_, i) => `<div style="background-image:url(${background})">`.repeat(300) + `<p>Payload ${i}</p>` + "</div>".repeat(300)).join("") + '<p id="last">Exact final mail text</p>';
const backgroundCap = '<div style="height:30000px"></div>' + `<div style="background-image:${Array(4).fill(`url(${background})`).join(",")}">`.repeat(240) + '<p id="last">Exact final mail text</p>' + '</div>'.repeat(240);
const largeSvg = '<div style="height:30000px"></div><svg viewBox="0 0 100 100">' + '<path d="M0 0h100v100H0z" fill="green"></path>'.repeat(100000) + '<text>Complete graphic label</text></svg><p id="last">Exact final mail text</p>';
const pattern = params.has("svg-inherited") ? '<pattern id="logo" patternUnits="userSpaceOnUse" width="1" height="1"><rect width="1" height="1" fill="currentColor"/></pattern>' : '<pattern id="logo" patternUnits="userSpaceOnUse" width="1" height="1"><image href="data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="lime"/></svg>') + '" width="1" height="1"/></pattern>';
const svgReference = '<div style="color:lime"><svg width="100" height="100"><defs>' + pattern + '</defs><rect id="control-pixel" width="100" height="100" fill="url(#logo)"/></svg></div><p style="height:30000px">' + 'Gap '.repeat(1800) + '</p><div style="color:red"><svg width="100" height="100"><rect id="referenced-pixel" width="100" height="100" fill="url(#logo)"/></svg></div><p id="last">Exact final mail text</p>';
const themeSvg = '<div style="height:30000px"></div>' + (params.has("svg-theme-link") ? '<a href="https://example.invalid/graphic">' : '') + '<svg viewBox="0 0 100 100"><rect id="theme-paint" width="100" height="100" fill="currentColor"/></svg>' + (params.has("svg-theme-link") ? '</a>' : '');
const html = (params.has("svg-theme") || params.has("svg-theme-link")) ? themeSvg : (params.has("svg-reference") || params.has("svg-inherited")) ? svgReference : params.has("large-svg") ? largeSvg : params.has("background-cap") ? backgroundCap : params.has("shrink") ? '<img style="display:block;width:100px;height:auto;aspect-ratio:auto 1 / 300" src="http://127.0.0.1:61640/mail-image" alt="Shrinking image">' : params.has("deep") ? deep() : params.has("late") ? '<p>First</p><img loading="lazy" style="position:absolute;top:19000px" src="http://127.0.0.1:61640/mail-image" alt="Late image">' : params.has("intrinsic") ? '<div><a style="white-space:pre-wrap" href="https://example.invalid/last">' + "Exact words 😀\n ".repeat(2000) + '</a><p id="last">Exact final mail text</p></div>' : params.has("remote") ? '<div style="height:30000px">First<img src="http://127.0.0.1:61640/mail-image" alt="Remote image"><img src="cid:logo" alt="Inline logo"></div><p id="last">Exact final mail text</p>' : params.has("overflow") ? '<div style="height:30px;overflow:hidden">' + "<p>Body line</p>".repeat(90) + '<p id="last">Exact final mail text</p></div>' : params.has("short") ? "<p>Short exact message</p>" : params.has("absolute") ? '<p>First</p><p id="last" style="position:absolute;top:30000px">Exact final mail text</p>' : physical
  ? Array.from({ length: blocks }, (_, i) => `<div style="height:1000000px">Block ${i}</div>`).join("") + '<p id="last">Exact final mail text</p>'
  : Array.from({ length: 1400 }, (_, i) => `<p style="margin:0;height:20px">Line ${i}</p>`).join("") + '<a id="last" href="https://example.invalid/last">Exact final mail text</a>';
useApp.setState({ selectedId: 1, readerOpen: true });
prepareReaderFixture(html);
if (params.has("keyboard")) (await import("../../src/lib/keyboard")).installKeyboard();
const inline = { id: 1, messageId: 1, filename: "Logo.png", mime: "image/png", size: atob(PNG).length, assetId: "cid-fixture", contentId: "logo" };
function Fixture() {
  const [body, setBody] = useState(html);
  const [identity, setIdentity] = useState(1);
  const [expanded, setExpanded] = useState(true);
  Object.assign(window, { fullFixture: { calls, original: html, cursor: () => { const state = useApp.getState(); return { selectedId: state.selectedId, anchorId: state.anchorId, readerOpen: state.readerOpen, checked: [...state.checked] }; }, replace: () => setBody("<p>Replacement short body</p>"), navigate: () => setIdentity(2), collapse: () => setExpanded(false) } });
  return <ModalHostProvider>
    {params.has("reader") ? <main style={{ height: 700 }}><ReaderFixture /></main> : <main style={{ height: 700 }}>
      <MailReaderView identity={identity}>
        <h1>Tall mail boundary fixture</h1>
        <div data-reader-scroller tabIndex={0} aria-label="Mail reader" style={{ height: 600, overflowY: "auto" }}>
          <Expand open={expanded}>
            <HtmlBody html={body} messageId={physical ? 2 : 1} accountId={1} attachments={params.has("remote") ? [inline] : []} remoteImages="ask" appearance="auto" />
          </Expand>
          <button type="button">Attachment after body</button>
        </div>
      </MailReaderView>
    </main>}
    <PrintSheet />
  </ModalHostProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
