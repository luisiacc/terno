/** Variables from when the app was called Única. */
export const LEGACY_ENV_PREFIX = "UNICA_";
export const ENV_PREFIX = "TERNO_";

/**
 * For one release, a UNICA_X variable still works: when TERNO_X isn't set,
 * it is copied there (so everything reads TERNO_X only) with a deprecation
 * warning; when both are set, TERNO_X wins and the old one is reported as
 * ignored. Either way the legacy name is removed, so child processes that
 * inherit this environment don't warn again. Returns the legacy names it adopted.
 */
export function adoptLegacyEnv(env: Record<string, string | undefined>, warn: (message: string) => void): string[] {
  const adopted: string[] = [];
  for (const legacy of Object.keys(env)) {
    if (!legacy.startsWith(LEGACY_ENV_PREFIX) || env[legacy] === undefined) continue;
    const name = ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length);
    if (env[name] === undefined) {
      env[name] = env[legacy];
      adopted.push(legacy);
      warn(`[terno] ${legacy} is deprecated: use ${name} (UNICA_* variables are read for one more release).`);
    } else {
      warn(`[terno] ${legacy} is ignored: ${name} is set.`);
    }
    delete env[legacy];
  }
  return adopted;
}
