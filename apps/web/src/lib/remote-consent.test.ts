import { describe, expect, it } from "vitest";
import { allowRemoteFor, remoteAllowed, useRemoteConsent } from "./remote-consent";

describe("remote content consent", () => {
  it("is per message and follows the setting", () => {
    const ask = { remoteImages: "ask" as const };
    expect(remoteAllowed(7, ask)).toBe(false);
    allowRemoteFor(7);
    expect(remoteAllowed(7, ask)).toBe(true);
    expect(remoteAllowed(8, ask)).toBe(false);
    expect(remoteAllowed(8, { remoteImages: "always" })).toBe(true);
    const before = useRemoteConsent.getState().allowed;
    allowRemoteFor(7);
    expect(useRemoteConsent.getState().allowed).toBe(before);
  });

  it("plan 35: local mode doesn't override the button or the setting", () => {
    // the settings object the reader passes carries localMode too; it must not matter
    const local = { remoteImages: "ask" as const, localMode: true };
    expect(remoteAllowed(41, local)).toBe(false);
    allowRemoteFor(41);
    expect(remoteAllowed(41, local)).toBe(true);
    const always = { remoteImages: "always" as const, localMode: true };
    expect(remoteAllowed(42, always)).toBe(true);
  });
});
