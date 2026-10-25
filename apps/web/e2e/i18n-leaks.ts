import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import type { Page } from "@playwright/test";

/**
 * English that must not show while Terno is in Spanish: every English
 * message whose Spanish differs, whole (a label) and by its static parts
 * of two or more words (a template like "Archived {count} conversations").
 * Mail content (subjects, senders, bodies, drafts) is skipped by where it
 * shows, and category and account names by what they are.
 */
const texts = (m: unknown): string[] => (typeof m === "string" ? [m] : m && typeof m === "object" ? Object.values(m as Record<string, string>) : []);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// the same in both languages, or too generic to flag (a word that Spanish also uses)
const SAME = new Set(["Terno", "Spam", "Zoom", "OK", "Gmail", "IMAP", "SMTP", "Cc", "Bcc", "PDF", "JSON", "MCP", "Ollama", "LM Studio", "A4", "Letter"]);

function englishOnly(): { whole: Set<string>; parts: string[] } {
  const whole = new Set<string>();
  const parts = new Set<string>();
  const spanish = new Set(Object.values(es).flatMap(texts).map(norm));
  for (const [key, message] of Object.entries(en)) {
    const other = (es as Record<string, unknown>)[key];
    for (const [i, text] of texts(message).entries()) {
      const s = norm(text.replace(/<\/?\w+>/g, ""));
      if (!/\p{L}/u.test(s) || SAME.has(s) || norm(texts(other)[i] ?? "") === s || spanish.has(s)) continue;
      if (!/[{#]/.test(s)) whole.add(s);
      for (const piece of s.split(/\{\w+\}|#/)) {
        const p = norm(piece).replace(/^[\s.,:;·…–-]+|[\s.,:;·…–-]+$/g, "");
        if (p.split(" ").length >= 2 && p.length >= 8 && !spanish.has(p)) parts.add(p);
      }
    }
  }
  return { whole, parts: [...parts] };
}

export const ENGLISH_ONLY = englishOnly();

/** Where mail itself shows: never copy. */
const MAIL_CONTENT = ["script", "style", "[aria-hidden=true]", "[data-testid=row-from]", "[data-testid=row-subject]", "[data-testid=row-snippet]", "[data-testid=reader-subject]", "[data-testid=message]", "[data-testid=strip-item]", "iframe", "[contenteditable]", "textarea"].join(",");

export interface Leak {
  text: string;
  where: string;
}

/** Visible text nodes and accessible strings (aria-label, title, placeholder) on the page that are English-only. */
export async function englishLeaks(page: Page): Promise<Leak[]> {
  const found = await page.evaluate((skip) => {
    const out: { text: string; where: string }[] = [];
    const app = (window as unknown as { __terno?: { getApp?: () => { categories: { name: string }[]; accounts: { displayName: string; email: string }[] } } }).__terno?.getApp?.();
    const names = new Set([...(app?.categories ?? []).map((c) => c.name), ...(app?.accounts ?? []).flatMap((a) => [a.displayName, a.email])]);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    };
    const describe = (el: Element) => el.closest("[data-testid]")?.getAttribute("data-testid") ?? el.tagName.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest(skip) || !visible(el)) continue;
      const text = (n.textContent ?? "").trim();
      if (text && !names.has(text)) out.push({ text, where: describe(el) });
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
      if (el.closest(skip)) continue;
      for (const attr of ["aria-label", "title", "placeholder"]) {
        const v = el.getAttribute(attr);
        if (v) out.push({ text: v, where: `${describe(el)}[${attr}]` });
      }
    }
    return out;
  }, MAIL_CONTENT);
  const leaks: Leak[] = [];
  for (const f of found) {
    const s = f.text.replace(/\s+/g, " ").trim();
    if (ENGLISH_ONLY.whole.has(s) || ENGLISH_ONLY.parts.some((p) => s.includes(p))) leaks.push({ text: s, where: f.where });
  }
  return leaks;
}
