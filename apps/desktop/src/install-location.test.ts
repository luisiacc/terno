import { describe, expect, it } from "vitest";
import { sanitizeFields } from "@terno/core/diag";
import { moveDestination, mustKeep, offerMove, offerMoveFrom, type InstallFrom, type InstallProbe, type InstallStep, type InstalledCopy, type OfferDeps } from "./install-location";

const ID = "dev.terno.mail";

function probe(over: Partial<InstallProbe> = {}): InstallProbe & { calls: string[] } {
  const calls: string[] = [];
  const track = <T,>(name: string, v: T) => () => (calls.push(name), v);
  return {
    packaged: true,
    platform: "darwin",
    testBuild: undefined,
    demo: false,
    background: false,
    linkWaiting: false,
    inApplications: track("inApplications", false),
    bundlePath: track("bundlePath", "/Volumes/Terno/Terno.app"),
    volumeReadOnly: track("volumeReadOnly", true),
    ownId: track("ownId", ID),
    version: "0.4.0",
    installed: track("installed", null),
    ...over,
    calls,
  };
}

describe("when Terno offers to move into Applications (plan 226)", () => {
  it("offers from the disk image, and from anywhere else outside Applications", () => {
    expect(offerMoveFrom(probe())).toBe("dmg");
    expect(offerMoveFrom(probe({ bundlePath: () => "/Users/x/Downloads/Terno.app", volumeReadOnly: () => false }))).toBe("elsewhere");
    // App Translocation: a randomized read-only path, not a volume
    expect(offerMoveFrom(probe({ bundlePath: () => "/private/var/folders/ab/T/AppTranslocation/1/d/Terno.app" }))).toBe("elsewhere");
    // an external drive that can be written is no disk image
    expect(offerMoveFrom(probe({ volumeReadOnly: () => false }))).toBe("elsewhere");
  });

  it("never asks a dev run, Linux, the demo, a background launch, a launch with a link, or a test build that didn't opt in", () => {
    expect(offerMoveFrom(probe({ packaged: false }))).toBeNull();
    expect(offerMoveFrom(probe({ platform: "linux" }))).toBeNull();
    expect(offerMoveFrom(probe({ demo: true }))).toBeNull();
    expect(offerMoveFrom(probe({ background: true }))).toBeNull();
    expect(offerMoveFrom(probe({ linkWaiting: true }))).toBeNull();
    expect(offerMoveFrom(probe({ testBuild: {} }))).toBeNull();
    expect(offerMoveFrom(probe({ testBuild: { offerInstall: true } }))).toBe("dmg");
  });

  it("checks the destination Electron moves to: /Applications under the bundle's own name", () => {
    expect(moveDestination("/Volumes/Terno/Terno.app")).toBe("/Applications/Terno.app");
    expect(moveDestination("/Users/x/Downloads/Terno 2.app")).toBe("/Applications/Terno 2.app");
  });

  it("an installed Terno pays one check and reads no file", () => {
    const p = probe({ inApplications: () => (p.calls.push("inApplications"), true) });
    expect(offerMoveFrom(p)).toBeNull();
    expect(p.calls).toEqual(["inApplications"]);
  });

  it("doesn't offer over a newer Terno, or over another app under the name; a same or older one is replaced", () => {
    const at = (installed: InstalledCopy | null) => offerMoveFrom(probe({ installed: () => installed }));
    expect(at({ id: ID, version: "0.5.0" })).toBeNull();
    expect(at({ id: "com.example.other", version: "0.1.0" })).toBeNull();
    expect(at({ id: ID, version: "0.4.0" })).toBe("dmg");
    expect(at({ id: ID, version: "0.3.9" })).toBe("dmg");
    // a version that can't be read doesn't block the same app
    expect(at({ id: ID, version: "" })).toBe("dmg");
    expect(mustKeep({ id: ID, version: "0.1.0" }, null, "0.4.0")).toBe(true);
  });
});

function deps(o: { answer?: boolean; move?: OfferDeps["move"]; installed?: () => InstalledCopy | null; linkWaiting?: () => boolean } = {}) {
  const steps: InstallStep[] = [];
  const quitting: boolean[] = [];
  let failedShown = 0;
  let moves = 0;
  const d: OfferDeps = {
    ask: async () => o.answer ?? true,
    move: (handler) => (moves++, (o.move ?? (() => true))(handler)),
    installed: o.installed ?? (() => null),
    linkWaiting: o.linkWaiting ?? (() => false),
    ownId: ID,
    version: "0.4.0",
    failed: async () => void failedShown++,
    quitting: (on) => void quitting.push(on),
    log: (step: InstallStep, _from: InstallFrom) => void steps.push(step),
  };
  return { d, steps, quitting, failed: () => failedShown, moves: () => moves };
}

describe("the offer (plan 226)", () => {
  it("Move: the quit gate opens for Electron's quit, and nothing else starts", async () => {
    const h = deps();
    expect(await offerMove("dmg", h.d)).toBe("moving");
    expect(h.quitting).toEqual([true]);
    expect(h.steps).toEqual(["offered", "moved"]);
  });

  it("Not Now never moves and starts Terno as usual", async () => {
    const h = deps({ answer: false });
    expect(await offerMove("dmg", h.d)).toBe("open");
    expect(h.moves()).toBe(0);
    expect(h.quitting).toEqual([]);
    expect(h.steps).toEqual(["offered", "declined"]);
  });

  it("a move that throws (a failed copy, a cancelled admin prompt) shuts the gate again, says how to install by hand, and starts Terno", async () => {
    const h = deps({ move: () => { throw new Error("User rejected the authorization request"); } });
    expect(await offerMove("elsewhere", h.d)).toBe("open");
    expect(h.quitting).toEqual([true, false]);
    expect(h.failed()).toBe(1);
    expect(h.steps).toEqual(["offered", "failed"]);
  });

  it("re-reads the destination right before the move: a newer Terno installed while the dialog was open is kept", async () => {
    let installed: InstalledCopy | null = null;
    // Electron's admin-password path replaces the destination without calling the conflict handler
    const h = deps({ installed: () => installed, move: () => true });
    h.d.ask = async () => ((installed = { id: ID, version: "0.9.0" }), true);
    expect(await offerMove("dmg", h.d)).toBe("open");
    expect(h.moves()).toBe(0);
    expect(h.quitting).toEqual([]);
    expect(h.steps).toEqual(["offered", "kept"]);
  });

  it("and again in the conflict handler, when Electron asks it", async () => {
    let reads = 0;
    const h = deps({ installed: () => (++reads > 1 ? { id: ID, version: "0.9.0" } : null), move: (conflict) => conflict("exists") });
    expect(await offerMove("dmg", h.d)).toBe("open");
    expect(h.quitting).toEqual([true, false]);
    expect(h.steps).toEqual(["offered", "kept"]);
  });

  it("a terno:// link that arrives while the dialog is open wins: Terno opens with it, and asks again next launch", async () => {
    let link = false;
    const h = deps({ linkWaiting: () => link });
    h.d.ask = async () => ((link = true), true);
    expect(await offerMove("dmg", h.d)).toBe("open");
    expect(h.moves()).toBe(0);
    expect(h.steps).toEqual(["offered", "deferred"]);
  });

  it("replaces an older copy that isn't running, and hands over to a running one", async () => {
    const older = deps({ installed: () => ({ id: ID, version: "0.1.0" }), move: (conflict) => conflict("exists") });
    expect(await offerMove("dmg", older.d)).toBe("moving");
    const running = deps({ installed: () => ({ id: ID, version: "0.4.0" }), move: (conflict) => conflict("existsAndRunning") });
    expect(await offerMove("dmg", running.d)).toBe("moving");
  });

  it("logs a step and where it ran from, nothing else, through the real sanitizer", () => {
    expect(sanitizeFields("install.offer", { installStep: "moved", installFrom: "dmg", path: "/Users/someone/Downloads" })).toEqual({ installStep: "moved", installFrom: "dmg" });
    expect(sanitizeFields("install.offer", { installStep: "/Volumes/Terno", installFrom: "x" })).toEqual({ installStep: "<redacted>", installFrom: "<redacted>" });
  });
});
