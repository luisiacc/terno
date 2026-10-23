/** Pure rules for rendering HTML mail (kept apart from the component so they can be tested in Node). */

/** Remote resources are blocked unless the user opts in: tracking pixels, remote CSS and fonts included. */
export function csp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return `default-src 'none'; img-src data: cid:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src 'none'; frame-src 'none'; form-action 'none'`;
}

export function hasRemoteContent(html: string): boolean {
  return /\b(src|background)\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
}

/** Does the mail paint its own colors (then it keeps them, on the paper card)? */
export function hasOwnColors(html: string): boolean {
  return /\s(?:bgcolor|color|text|link)\s*=/i.test(html) || /style\s*=\s*["'](?:[^"']*[;\s])?(?:color|background(?:-color)?)\s*:/i.test(html);
}
