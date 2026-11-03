// The signing identity in electron-builder's terms. package.mjs picks the full
// keychain name ("Developer ID Application: Luisiacc LLC (TEAMID)") to detect a
// Developer ID and to probe codesign, but electron-builder refuses a name with
// that prefix ("Please remove prefix …") and finds the certificate itself from
// the rest, so the builder gets the name without it (plan 126 review).
const PREFIX = /^Developer ID Application:\s*/;

/** `identity` as electron-builder's `mac.identity` takes it. */
export function builderIdentity(identity) {
  return identity.replace(PREFIX, "");
}
