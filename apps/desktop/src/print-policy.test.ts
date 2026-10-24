import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { fileMenu, footerTemplate, tempSibling, isTrustedSender, MAX_HTML_BYTES, parsePrintJob, pdfFileName, PRINT_COMMANDS, printCsp, printOutcome, requestAllowed, testPdfDir, withHead } from "./print-policy";

const job = { html: "<!doctype html><html><head></head><body>x</body></html>", action: "pdf", paper: "letter", subject: "Factura", headers: true, remote: [] as unknown[] };

describe("main: print jobs", () => {
  it("accepts a well-formed job and normalizes its remote URLs", () => {
    expect(parsePrintJob({ ...job, remote: ["https://img.test/a b.png"] })).toEqual({ ...job, remote: ["https://img.test/a%20b.png"] });
    expect(parsePrintJob({ ...job, action: "print", paper: "a4", headers: false })).toMatchObject({ action: "print", paper: "a4", headers: false });
  });

  it("refuses wrong types, unknown enums, oversized documents and non-web remote URLs", () => {
    const bad: unknown[] = [
      null,
      "job",
      { ...job, html: 42 },
      { ...job, action: "fax" },
      { ...job, paper: "legal" },
      { ...job, subject: null },
      { ...job, headers: "yes" },
      { ...job, remote: "https://x.test" },
      { ...job, remote: ["file:///etc/passwd"] },
      { ...job, remote: ["javascript:alert(1)"] },
      { ...job, remote: ["not a url"] },
      { ...job, remote: [42] },
      { ...job, remote: Array.from({ length: 2001 }, (_, i) => `https://x.test/${i}`) },
      { ...job, html: "é".repeat(MAX_HTML_BYTES / 2 + 1) },
    ];
    for (const b of bad) expect(parsePrintJob(b)).toBeNull();
  });

  it("only the app's own page, in its top frame, may print", () => {
    expect(isTrustedSender("app://terno/", true, null)).toBe(true);
    expect(isTrustedSender("app://terno/", false, null)).toBe(false);
    expect(isTrustedSender("app://unica/", true, null)).toBe(false);
    expect(isTrustedSender("https://evil.test/", true, null)).toBe(false);
    expect(isTrustedSender("http://localhost:5173/", true, "http://localhost:5173")).toBe(true);
    expect(isTrustedSender("http://localhost:5173/", true, null)).toBe(false);
    expect(isTrustedSender("about:blank", true, "")).toBe(false);
  });
});

describe("main: what the print window may load", () => {
  const active = { url: "terno-print://job/abc", remote: new Set(["https://img.test/hero.png"]) };

  it("its own document, as the top frame, and nothing else of the scheme", () => {
    expect(requestAllowed({ url: "terno-print://job/abc", resourceType: "mainFrame" }, active, true)).toBe(true);
    expect(requestAllowed({ url: "terno-print://job/abc", resourceType: "subFrame" }, active, false)).toBe(false);
    expect(requestAllowed({ url: "terno-print://job/other", resourceType: "mainFrame" }, active, false)).toBe(false);
    expect(requestAllowed({ url: "terno-print://job/abc", resourceType: "mainFrame" }, null, false)).toBe(false);
  });

  it("approved images only, never in local mode, never anything else", () => {
    expect(requestAllowed({ url: "https://img.test/hero.png", resourceType: "image" }, active, false)).toBe(true);
    expect(requestAllowed({ url: "https://img.test/hero.png", resourceType: "image" }, active, true)).toBe(false);
    expect(requestAllowed({ url: "https://img.test/other.png", resourceType: "image" }, active, false)).toBe(false);
    expect(requestAllowed({ url: "https://img.test/hero.png", resourceType: "script" }, active, false)).toBe(false);
    expect(requestAllowed({ url: "https://img.test/hero.png", resourceType: "xhr" }, active, false)).toBe(false);
    // a redirect arrives as a new URL: not on the list
    expect(requestAllowed({ url: "https://tracker.test/pixel.gif", resourceType: "image" }, active, false)).toBe(false);
  });

  it("the window's CSP allows web images only when some were approved, and never scripts", () => {
    expect(printCsp(false)).toContain("img-src data:;");
    expect(printCsp(false)).not.toMatch(/https?:/);
    expect(printCsp(true)).toContain("img-src data: https: http:;");
    for (const c of [printCsp(true), printCsp(false)]) expect(c).toContain("default-src 'none'");
  });
});

describe("main: the document and the PDF", () => {
  it("puts main's CSP and title first in <head>, escaped", () => {
    const out = withHead("<!doctype html><html><head><title>Del correo</title></head><body></body></html>", { csp: printCsp(false), title: `</title><script>x</script>` });
    expect(out).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;;[^"]*"><title>&lt;\/title&gt;&lt;script&gt;x&lt;\/script&gt;<\/title><title>Del correo<\/title>/);
    expect(withHead("<p>x</p>", { csp: "default-src 'none'", title: "T" })).toMatch(/^<!doctype html><head><meta [^>]+><title>T<\/title><\/head><p>x<\/p>$/);
  });

  it("the footer holds the escaped, shortened subject and the page numbers", () => {
    const f = footerTemplate(`<img src=x onerror=alert(1)> ${"a".repeat(200)}`);
    expect(f).not.toContain("<img");
    expect(f).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(f).toContain("…");
    expect(f).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>');
    expect(f).toContain("font:8pt");
    expect(footerTemplate("  ")).toContain("(sin asunto)");
  });

  it("names the file like the renderer, safe for any path", () => {
    expect(pdfFileName("../../Library/x")).toBe("Library x");
    expect(pdfFileName("Re: Junta 3/11")).toBe("Re Junta 3 11");
    expect(pdfFileName("")).toBe("Correo");
  });

  it("caps the name by UTF-8 bytes between graphemes, so long CJK or emoji subjects still save", () => {
    const bytes = (s: string) => Buffer.byteLength(s);
    const cjk = pdfFileName("報".repeat(80));
    expect(bytes(`${cjk}.pdf`)).toBeLessThanOrEqual(255);
    expect(bytes(cjk)).toBeLessThanOrEqual(200);
    expect(cjk).toBe("報".repeat(66));
    const emoji = pdfFileName("😀".repeat(80));
    expect(bytes(emoji)).toBeLessThanOrEqual(200);
    // whole code points only: no lone surrogate survives the round trip
    expect(Buffer.from(emoji, "utf8").toString("utf8")).toBe(emoji);
    const family = "👨‍👩‍👧‍👦";
    const families = pdfFileName(family.repeat(40));
    expect(families.length % family.length).toBe(0);
    expect(families.startsWith(family)).toBe(true);
    // the temp file's name never grows with the subject
    const tmp = tempSibling("/Users/x/Downloads", "0123456789abcdef");
    expect(tmp).toBe("/Users/x/Downloads/.terno-export-0123456789abcdef.tmp");
    expect(bytes(tmp.split("/").pop()!)).toBeLessThan(40);
  });

  it("reports what the user did: submitted, cancelled, or why it failed", () => {
    expect(printOutcome(true, "")).toEqual({ status: "submitted" });
    expect(printOutcome(false, "Print job canceled")).toEqual({ status: "cancelled" });
    expect(printOutcome(false, "No printers available on the network")).toEqual({ status: "failed", reason: "no-printers" });
    expect(printOutcome(false, "Print job failed")).toEqual({ status: "failed", reason: "error" });
  });

  it("saves without a panel only for the smoke: a dev build or the demo mailbox", () => {
    expect(testPdfDir({ TERNO_TEST_PDF_DIR: "/tmp/x" }, false, false)).toBe("/tmp/x");
    expect(testPdfDir({ TERNO_TEST_PDF_DIR: "/tmp/x" }, true, true)).toBe("/tmp/x");
    expect(testPdfDir({ TERNO_TEST_PDF_DIR: "/tmp/x" }, true, false)).toBeNull();
    expect(testPdfDir({}, false, true)).toBeNull();
  });
});

describe("main: the Archivo menu", () => {
  it("sends only whitelisted commands, with the platform's print accelerators", () => {
    const sent: string[] = [];
    const menu = fileMenu((c) => sent.push(c));
    const items = menu.submenu as MenuItemConstructorOptions[];
    expect(menu.label).toBe("Archivo");
    expect(items.map((i) => [i.label, i.accelerator])).toEqual([
      ["Imprimir…", "CmdOrCtrl+P"],
      ["Exportar como PDF…", "CmdOrCtrl+Shift+P"],
    ]);
    for (const i of items) (i.click as () => void)();
    expect(sent).toEqual(["thread.print", "thread.exportPdf"]);
    for (const c of sent) expect(PRINT_COMMANDS).toContain(c);
  });
});
