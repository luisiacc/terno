/**
 * Main process entry. The same executable also runs as the one-shot keychain
 * helper (keychain-helper.ts); otherwise diagnostics start first (their files
 * open once the profile is known), the profile is made ready (legacy Única
 * profiles renamed) before anything opens it, then the app starts.
 */
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { mainDiag } from "./diag/main";
import { KEYCHAIN_HELPER_FLAG, runKeychainHelper } from "./keychain-helper";
import { prepareProfile } from "./profile";

if (process.argv.includes(KEYCHAIN_HELPER_FLAG)) {
  runKeychainHelper();
} else {
  mainDiag.installEarly();
  adoptLegacyEnv(process.env, (m) => console.warn(m));
  if (prepareProfile()) require("./app");
}
