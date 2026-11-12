import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The app's profile, where its agent socket, token and logs are: TERNO_USER_DATA, else where Electron puts a
 * profile named Terno: ~/Library/Application Support on macOS, $XDG_CONFIG_HOME (or ~/.config) elsewhere (plan 189).
 */
export function profileDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.TERNO_USER_DATA) return env.TERNO_USER_DATA;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Terno");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Terno");
}
