import { describe, expect, it } from "vitest";
import { allowRemoteFor, remoteAllowed, useRemoteConsent } from "./remote-consent";

describe("remote content consent", () => {
  it("is per message, follows the setting, and local mode always wins", () => {
    const ask = { remoteImages: "ask" as const, localMode: false };
    expect(remoteAllowed(7, ask)).toBe(false);
    allowRemoteFor(7);
    expect(remoteAllowed(7, ask)).toBe(true);
    expect(remoteAllowed(8, ask)).toBe(false);
    expect(remoteAllowed(8, { remoteImages: "always", localMode: false })).toBe(true);
    expect(remoteAllowed(7, { ...ask, localMode: true })).toBe(false);
    expect(remoteAllowed(8, { remoteImages: "always", localMode: true })).toBe(false);
    const before = useRemoteConsent.getState().allowed;
    allowRemoteFor(7);
    expect(useRemoteConsent.getState().allowed).toBe(before);
  });
});
