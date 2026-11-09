import { DEV_AI_ENV } from "@terno/core";

/** Plan 146: Dev mode is for a local run on the dev server; an installed app never reads its environment for keys, whatever it's given. */
export function devModeOf(o: { devUrl: string | undefined; packaged: boolean }): boolean {
  return Boolean(o.devUrl) && !o.packaged;
}

/**
 * Plan 161 (Codex review): Dev mode's keys are the backend's alone. Main takes them out of its own environment at start,
 * so nothing it spawns inherits them (a helper like scutil, an agent), and hands them to the backend's fork only when Dev
 * mode applies. A packaged app given keys in its environment keeps none.
 */
export function takeDevAiEnv(env: Record<string, string | undefined>): Record<string, string> {
  const taken: Record<string, string> = {};
  for (const name of Object.values(DEV_AI_ENV)) {
    const value = env[name];
    delete env[name];
    if (value) taken[name] = value;
  }
  return taken;
}

/** The backend's environment: main's, plus Dev mode's keys when it applies. */
export function backendEnv(env: Record<string, string | undefined>, keys: Record<string, string>, devMode: boolean): Record<string, string | undefined> {
  return devMode ? { ...env, ...keys } : { ...env };
}
