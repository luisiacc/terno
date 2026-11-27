import { mailtoLink } from "@terno/core";

/** Plan 284: a link a right-click was on, as the reader's menu offers it */
export type MenuLink = { kind: "mail"; to: string; subject: string } | { kind: "web"; href: string };

/** An address to write to (one valid `mailto:`), a page to open (http, https), or nothing the menu offers. */
export function menuLink(href: string): MenuLink | null {
  if (/^mailto:/i.test(href)) {
    const mail = mailtoLink(href);
    return mail && { kind: "mail", to: mail.to, subject: mail.subject };
  }
  return /^https?:\/\/[^\s]/i.test(href) ? { kind: "web", href } : null;
}

/**
 * The link a right-click landed on (its own element or inside it), from what the menu was opened on. As the mail wrote it:
 * a mail's frame resolves "#top" or "" against the app's own address, which is no page to offer.
 */
export function linkAt(origin: Element | null): MenuLink | null {
  const href = origin?.closest?.("a[href]")?.getAttribute("href")?.trim();
  return href ? menuLink(href) : null;
}
