/**
 * Reading exported PDFs back (plan 09 §9.11): page sizes and every text item
 * with its position, through pdfjs-dist's legacy build in Node (text needs no
 * canvas). The web print-quality suite and the desktop print smoke check
 * their PDFs against the same expectations.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import type { PrintFixtureKey } from "@terno/mock-data";

/** pdfjs needs its CMaps for CJK fonts (and its standard font data), from the pinned package. */
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export interface PdfText {
  str: string;
  /** PDF points from the page's left and bottom edges */
  x: number;
  y: number;
  width: number;
}
export interface PdfPage {
  width: number;
  height: number;
  items: PdfText[];
}

export async function readPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, cMapUrl: `${join(PDFJS_DIR, "cmaps")}/`, cMapPacked: true, standardFontDataUrl: `${join(PDFJS_DIR, "standard_fonts")}/` });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const content = await page.getTextContent();
    const items = content.items.flatMap((i) => ("str" in i && i.str.trim() ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width }] : []));
    pages.push({ width: x1 - x0, height: y1 - y0, items });
  }
  await task.destroy();
  return pages;
}

const PT = 72 / 25.4;
/** The page geometry every print uses (apps/web/src/lib/print.ts), in points. */
export const SIZE = { letter: { width: 612, height: 792 }, a4: { width: 595.28, height: 841.89 } } as const;
export const MARGIN_PT = { side: 16 * PT, top: 18 * PT, bottom: 18 * PT };

/** A search that brings each fixture's conversation up alone. */
export const QUERY: Record<PrintFixtureKey, string> = {
  "long-plain": 'subject:"Notas de la junta de planeación"',
  "inline-replies": 'subject:"Preguntas sobre el contrato"',
  newsletter: 'subject:"Boletín Acme"',
  "wide-table": 'subject:"Reporte de ventas por región"',
  "cjk-emoji": "from:kenji.sato@tokyo-office.jp",
  "long-urls": 'subject:"Enlaces del proyecto"',
  images: 'subject:"Fotos de la visita"',
  hostile: "from:soporte@banco-falso.test",
};

export interface FixtureExpectation {
  /** in the print in both modes */
  text: string[];
  /** never in the print (quoted history hidden, sanitized markup) */
  absent: string[];
  pages: [number, number];
  /** with headers only: the attachment list and such */
  headersText?: string[];
}

export const EXPECT: Record<PrintFixtureKey, FixtureExpectation> = {
  "long-plain": { text: ["Te comparto las notas de la junta", "Perfecto. Nos vemos el jueves."], absent: ["escribió:"], pages: [1, 4] },
  "inline-replies": { text: ["A 30 días naturales desde la factura.", "¿Y a partir del usuario 21?", "con eso lo firmamos el lunes"], absent: ["Enviado:", "escribió:"], pages: [1, 3] },
  newsletter: { text: ["Lo nuevo de este mes", "Darse de baja", "Promoción de temporada"], absent: [], pages: [1, 3] },
  "wide-table": { text: ["Variación", "Metropolitana", "101%"], absent: [], pages: [1, 2] },
  "cjk-emoji": { text: ["来週の東京オフィス訪問の日程", "我们会在会议上提供中文资料", "서울 팀도 화상으로 참여합니다"], absent: [], pages: [1, 2] },
  "long-urls": { text: ["drive.example.test", "Clave:"], absent: [], pages: [1, 2] },
  images: { text: ["Plano de la planta baja", "Foto en alta resolución del acceso norte"], absent: [], pages: [1, 3], headersText: ["planta-baja.png"] },
  hostile: { text: ["Tu factura está lista."], absent: ["alert(4)", "body{background"], pages: [1, 1] },
};

/** Everything wrong with an exported PDF of a fixture, as readable lines (empty: fine). */
export function pdfProblems(pages: PdfPage[], o: { key: PrintFixtureKey; headers: boolean; paper: "letter" | "a4"; subject: string; sender: string }): string[] {
  const e = EXPECT[o.key];
  const out: string[] = [];
  const size = SIZE[o.paper];
  if (pages.length < e.pages[0] || pages.length > e.pages[1]) out.push(`${pages.length} pages, expected ${e.pages.join("–")}`);
  // text runs split anywhere: compared without whitespace; NFKC, because pdfjs reads some CJK glyphs as their Kangxi radicals (⽇ for 日)
  // emoji may print as glyphs or as images: left out on both sides
  const flat = (s: string) => s.normalize("NFKC").replace(/(?:\s|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u{FE0F}|\u{200D})+/gu, "");
  const all = flat(pages.flatMap((p) => p.items.map((i) => i.str)).join(""));
  for (const [n, p] of pages.entries()) {
    if (Math.abs(p.width - size.width) > 1 || Math.abs(p.height - size.height) > 1) out.push(`page ${n + 1} is ${p.width}×${p.height}pt, not ${o.paper}`);
    for (const i of p.items) {
      // nothing past the printable box at the sides: clipped text would show here
      if (i.x < MARGIN_PT.side - 1.5 || i.x + i.width > p.width - MARGIN_PT.side + 1.5) out.push(`page ${n + 1}: «${i.str.slice(0, 40)}» at x ${i.x.toFixed(1)}–${(i.x + i.width).toFixed(1)} leaves the printable box`);
      // the bottom margin holds the footer, with headers only
      if (i.y < MARGIN_PT.bottom - 2 && !o.headers) out.push(`page ${n + 1}: «${i.str.slice(0, 40)}» in the bottom margin of a content-only print`);
    }
  }
  for (const t of [...e.text, ...(o.headers ? (e.headersText ?? []) : [])]) if (!all.includes(flat(t))) out.push(`missing «${t}»`);
  for (const t of e.absent) if (all.includes(flat(t))) out.push(`should not print «${t}»`);
  // the whole subject: a part of it may be in the body
  const headerBits = [o.sender, o.subject];
  for (const t of headerBits) {
    const has = all.includes(flat(t));
    if (o.headers && !has) out.push(`headers mode is missing «${t}»`);
    if (!o.headers && has) out.push(`content only prints «${t}»`);
  }
  // the recipients' label in the app's language (the web suite runs in English; the desktop smoke follows the Mac's)
  const to = new Set<string>([en["print.doc.to"], es["print.doc.to"]]);
  const labels = pages.flatMap((p) => p.items).filter((i) => to.has(i.str.trim())).length;
  if (!o.headers && labels) out.push("content only prints the «To» label");
  if (o.headers && !labels) out.push("headers mode has no «To» label");
  // the footer: the page number on every page, with headers
  const footed = pages.filter((p) => p.items.some((i) => i.y < MARGIN_PT.bottom && /\d/.test(i.str))).length;
  if (o.headers && footed !== pages.length) out.push(`footer page numbers on ${footed} of ${pages.length} pages`);
  return out;
}
