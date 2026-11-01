import { createRoot } from "react-dom/client";
import { useAppearance } from "../../src/lib/appearance";
import { HtmlBody } from "../../src/components/mail-body";

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", dark);
useAppearance.setState({ mode: dark ? "dark" : "light" });

const params = new URLSearchParams(location.search);
const physical = params.has("physical");
const blocks = params.has("control") ? 2 : 40;
const html = physical
  ? Array.from({ length: blocks }, (_, i) => `<div style="height:1000000px">Block ${i}</div>`).join("") + '<p id="last">Exact final mail text</p>'
  : Array.from({ length: 1400 }, (_, i) => `<p style="margin:0;height:20px">Line ${i}</p>`).join("") + '<a id="last" href="https://example.invalid/last">Exact final mail text</a>';
createRoot(document.getElementById("root")!).render(
  <main>
    <h1>Tall mail boundary fixture</h1>
    <div data-reader-scroller tabIndex={0} aria-label="Mail reader" style={{ height: 600, overflowY: "auto" }}>
      <HtmlBody html={html} messageId={physical ? 2 : 1} remoteImages="ask" appearance="auto" />
      <button type="button">Attachment after body</button>
    </div>
  </main>,
);
