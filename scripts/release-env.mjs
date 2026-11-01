import { readFileSync } from "node:fs";

// What a release build carries (plan 78). The DSN is public by design: it can
// only submit events, to the `terno` project (luisiaccorg). A release gets it
// unless TERNO_SENTRY_DSN says otherwise (empty: reports off, e.g. a fork);
// dev, demo and test builds never do.
export const TERNO_DSN = "https://94ef4113e2c6f556c30c47b6533c43d7@o4505891924738048.ingest.us.sentry.io/4512346705166336";
export const SENTRY_ORG = "luisiaccorg";
export const SENTRY_PROJECT = "terno";

/** The DSN a build bakes in: the override if set, else ours for a release, else none. */
export function buildDsn(env = process.env) {
  if (env.TERNO_SENTRY_DSN !== undefined) return env.TERNO_SENTRY_DSN;
  return env.TERNO_RELEASE === "1" ? TERNO_DSN : "";
}

/** The repo's .env (git-ignored), under the process environment: what is already set wins. */
export function withDotEnv(env = process.env, file = new URL("../.env", import.meta.url)) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return { ...env }; }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { ...out, ...env };
}

/**
 * Plan 99: Terno's own Google Desktop clients, baked into a build so connecting Gmail needs
 * no setup. Every one the build has goes in (dev and release share a profile, and a refresh
 * token works only with the client that issued it); a release prefers prod, anything else dev.
 * An installed app's client secret isn't confidential (PKCE and the loopback protect the flow).
 * A release without its client fails, unless TERNO_GOOGLE_DESKTOP_ID="" says so (a fork).
 */
export function buildGoogleClients(env = withDotEnv()) {
  const release = env.TERNO_RELEASE === "1";
  const pair = (id, secret) => (id ? [{ clientId: id, clientSecret: secret ?? "" }] : []);
  const prod = pair(env.TERNO_GOOGLE_DESKTOP_ID, env.TERNO_GOOGLE_DESKTOP_SECRET);
  const dev = pair(env.TERNO_GOOGLE_DESKTOP_DEV_ID, env.TERNO_GOOGLE_DESKTOP_DEV_SECRET);
  if (release && !prod.length) {
    if (env.TERNO_GOOGLE_DESKTOP_ID === "") return null;
    throw new Error("a release needs Terno's Google client: set TERNO_GOOGLE_DESKTOP_ID and TERNO_GOOGLE_DESKTOP_SECRET (in .env), or TERNO_GOOGLE_DESKTOP_ID= for none");
  }
  const clients = release ? [...prod, ...dev] : [...dev, ...prod];
  return clients.length ? { preferred: clients[0].clientId, clients } : null;
}
