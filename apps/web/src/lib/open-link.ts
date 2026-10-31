/** Opens a link from mail in the browser (desktop: the system's), never in Terno; only http(s) and mailto. */
export function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (window.ternoDesktop) window.ternoDesktop.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}
