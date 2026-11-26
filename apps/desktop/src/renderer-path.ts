import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Plan 283: the file an app:// path names inside the renderer's folder, or null when it would leave it (or is the
 * folder itself). Exact containment by the relative path, not a string prefix: a sibling such as `renderer-old/`
 * shares the prefix.
 */
export function rendererFile(root: string, pathname: string): string | null {
  const file = join(root, pathname);
  const rel = relative(root, file);
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return file;
}
