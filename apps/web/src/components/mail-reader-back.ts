/** The reader's current child page consumes Back before conversation navigation. */
let back: (() => void) | null = null;
export function registerMailReaderBack(close: () => void): () => void {
  back = close;
  return () => { if (back === close) back = null; };
}
export function returnFromMailReaderView(): boolean {
  if (!back) return false;
  back();
  return true;
}
