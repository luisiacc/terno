/**
 * Main process entry. A packaged app first refuses the DevTools protocol
 * without a Node inspector (plan 283, debugging.ts). The same executable also
 * runs as the one-shot keychain helper (keychain-helper.ts); otherwise
 * diagnostics start first (their files open once the profile is known), the
 * profile is made ready (legacy Única profiles renamed) before anything opens
 * it, then the app starts.
 */
// first: a test build's baked profile and name, before anything reads the environment (a no-op in a release)
import "./test-build";
import { url as inspectorUrl } from "node:inspector";
import { app } from "electron";
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { packagedApp, refusedProtocolSwitch } from "./debugging";
import { mainDiag } from "./diag/main";
import { KEYCHAIN_HELPER_FLAG, runKeychainHelper } from "./keychain-helper";
import { prepareProfile } from "./profile";

// before ready, so before Chromium starts serving the protocol
const refused = refusedProtocolSwitch({ packaged: packagedApp(app.isPackaged, __dirname), inspectorUrl: inspectorUrl(), hasSwitch: (s) => app.commandLine.hasSwitch(s) });
if (refused) {
  process.stderr.write(`Terno doesn't open the DevTools protocol (--${refused}) in a packaged build.\n`);
  app.exit(1);
} else if (process.argv.includes(KEYCHAIN_HELPER_FLAG)) {
  runKeychainHelper();
} else {
  mainDiag.installEarly();
  adoptLegacyEnv(process.env, (m) => console.warn(m));
  if (prepareProfile()) require("./app");
}
