/** Plan 65: folder paths in name order, one level at a time (a parent before its children, never after a sibling's prefix). */
export function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = a[i]!.localeCompare(b[i]!);
    if (c) return c;
  }
  return a.length - b.length;
}
