import { describe, expect, it } from "vitest";
import { initialUpdateState, notesText, reduceUpdate, type UpdateEvent, type UpdateInfo, type UpdateState } from "./state";

const info = (version: string): UpdateInfo => ({ version, notes: "", size: 100, releaseDate: null });
const start = () => initialUpdateState({ current: "0.1.0", mode: "auto", channel: "stable", localMode: false });
const run = (s: UpdateState, ...events: UpdateEvent[]) => events.reduce(reduceUpdate, s);

describe("updates: the state machine", () => {
  it("the happy path: check → available → downloading (percent) → verifying → ready → installing", () => {
    let s = run(start(), { type: "check-start" });
    expect(s.status).toBe("checking");
    s = run(s, { type: "available", at: 10, update: info("0.2.0") });
    expect(s).toMatchObject({ status: "available", available: { version: "0.2.0" }, checkedAt: 10 });
    s = run(s, { type: "download-start" }, { type: "download-progress", percent: 41.7 });
    expect(s).toMatchObject({ status: "downloading", percent: 41 });
    s = run(s, { type: "downloaded" });
    // electron-updater's "downloaded" is not ready: Squirrel hasn't checked the signature yet
    expect(s).toMatchObject({ status: "verifying", ready: null });
    s = run(s, { type: "ready" });
    expect(s).toMatchObject({ status: "ready", ready: { version: "0.2.0" }, percent: 100 });
    s = run(s, { type: "install-start" });
    expect(s.status).toBe("installing");
  });

  it("nothing new: up to date, and a check without anything found clears an old offer", () => {
    expect(run(start(), { type: "check-start" }, { type: "not-available", at: 5 })).toMatchObject({ status: "up-to-date", available: null, checkedAt: 5 });
    expect(run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "not-available", at: 2 })).toMatchObject({ status: "up-to-date", available: null });
  });

  describe("errors and retries", () => {
    const ready = () => run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "downloaded" }, { type: "ready" });

    it.each([
      ["check fails with nothing found yet", run(start(), { type: "check-start" }), { type: "check-failed", at: 3, kind: "offline" } as UpdateEvent, { status: "error", error: { stage: "check", kind: "offline", canRetry: true } }],
      ["download fails: the offer stays, retry downloads again", run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }), { type: "download-failed", kind: "server" } as UpdateEvent, { status: "available", available: { version: "0.2.0" }, error: { stage: "download", kind: "server", canRetry: true } }],
      ["a corrupted zip (sha512) is an integrity error", run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }), { type: "download-failed", kind: "integrity" } as UpdateEvent, { status: "available", error: { stage: "download", kind: "integrity" } }],
      ["Squirrel refuses the bundle (signature): verify error, retry re-downloads", run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "downloaded" }), { type: "verify-failed", kind: "integrity" } as UpdateEvent, { status: "available", ready: null, error: { stage: "verify", canRetry: true } }],
      ["install fails: still ready, retry installs again", ready(), { type: "install-failed", kind: "unknown" } as UpdateEvent, { status: "ready", error: { stage: "install", canRetry: true } }],
      ["the new version never started: not applied, retry checks again", start(), { type: "not-applied", version: "0.2.0" } as UpdateEvent, { status: "error", error: { stage: "install", kind: "not-applied", canRetry: true } }],
    ])("%s", (_name, before, event, expected) => {
      expect(reduceUpdate(before, event)).toMatchObject(expected);
    });

    it("a download failing with no offer can't be retried by downloading", () => {
      expect(reduceUpdate(run(start(), { type: "check-start" }), { type: "download-failed", kind: "server" }).error).toMatchObject({ canRetry: false });
    });

    it("a ready update survives later checks that fail or find nothing, and a check runs quietly beside it", () => {
      let s = run(ready(), { type: "check-start" });
      expect(s.status).toBe("ready");
      s = run(s, { type: "check-failed", at: 9, kind: "offline" });
      expect(s).toMatchObject({ status: "ready", ready: { version: "0.2.0" }, error: null, checkedAt: 9 });
      s = run(s, { type: "not-available", at: 10 });
      expect(s).toMatchObject({ status: "ready", ready: { version: "0.2.0" } });
      s = run(s, { type: "available", at: 11, update: info("0.2.0") });
      expect(s).toMatchObject({ status: "ready" });
    });

    it("a newer release while one is ready: offered and downloaded, the ready one stays until replaced", () => {
      let s = run(ready(), { type: "available", at: 12, update: info("0.2.1") });
      expect(s).toMatchObject({ status: "ready", ready: { version: "0.2.0" }, available: { version: "0.2.1" } });
      s = run(s, { type: "download-start" }, { type: "download-failed", kind: "offline" });
      expect(s).toMatchObject({ status: "ready", ready: { version: "0.2.0" } });
      s = run(s, { type: "download-start" }, { type: "downloaded" }, { type: "ready" });
      expect(s.ready?.version).toBe("0.2.1");
    });

    it("Squirrel's verdict belongs to the download it checked, not to a newer offer that came in meanwhile", () => {
      const verifying = run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "downloaded" });
      const offered = run(verifying, { type: "available", at: 2, update: info("0.2.1") });
      expect(offered).toMatchObject({ status: "verifying", available: { version: "0.2.1" } });
      expect(run(offered, { type: "ready" })).toMatchObject({ status: "ready", ready: { version: "0.2.0" } });
      // and the same while downloading
      const downloading = run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "available", at: 2, update: info("0.2.1") });
      expect(downloading.status).toBe("downloading");
      expect(run(downloading, { type: "downloaded" }, { type: "ready" }).ready?.version).toBe("0.2.0");
    });

    it("a check never interrupts a download, a verification or an install", () => {
      for (const s of [
        run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }),
        run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "downloaded" }),
        run(ready(), { type: "install-start" }),
      ]) {
        expect(reduceUpdate(s, { type: "check-start" })).toBe(s);
      }
    });
  });

  it("restart while a send is in flight: deferred (still ready), then installing clears it", () => {
    const s = run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" }, { type: "downloaded" }, { type: "ready" }, { type: "install-start" }, { type: "install-deferred", reason: "sending" });
    expect(s).toMatchObject({ status: "ready", deferred: "sending" });
    expect(run(s, { type: "install-start" })).toMatchObject({ status: "installing", deferred: null });
  });

  it("cancelled work (local mode turned on) settles back without losing the offer or a ready update", () => {
    const offered = run(start(), { type: "available", at: 1, update: info("0.2.0") }, { type: "download-start" });
    expect(run(offered, { type: "cancelled" })).toMatchObject({ status: "available", percent: null });
    expect(run(start(), { type: "check-start" }, { type: "cancelled" }).status).toBe("idle");
  });

  it("switching channel drops the other channel's offer; while an update is staged (Squirrel can't unstage it) the channel stays", () => {
    const offered = run(start(), { type: "available", at: 1, update: info("0.3.0-nightly.1") });
    expect(run(offered, { type: "prefs", mode: "auto", channel: "nightly" })).toMatchObject({ status: "idle", available: null, channel: "nightly" });
    const staged = run(offered, { type: "download-start" }, { type: "downloaded" }, { type: "ready" });
    expect(run(staged, { type: "prefs", mode: "manual", channel: "nightly" })).toMatchObject({ status: "ready", channel: "stable", mode: "manual", ready: { version: "0.3.0-nightly.1" } });
    // the same channel: only the mode changes
    expect(run(offered, { type: "prefs", mode: "manual", channel: "stable" })).toMatchObject({ status: "available", mode: "manual" });
  });

  it("an unsupported copy stays unsupported", () => {
    const s = run(start(), { type: "unsupported", reason: "dmg" });
    expect(s).toMatchObject({ status: "unsupported", unsupported: "dmg" });
    expect(run(s, { type: "check-start" }, { type: "available", at: 1, update: info("0.2.0") }, { type: "ready" })).toBe(s);
    expect(run(s, { type: "local-mode", on: true }).localMode).toBe(true);
  });

  it("after an update: justUpdated once, until seen", () => {
    const s = run(start(), { type: "applied", version: "0.1.0" });
    expect(s.justUpdated).toBe("0.1.0");
    expect(run(s, { type: "seen" }).justUpdated).toBeNull();
  });
});

describe("updates: release notes as plain text", () => {
  it("drops tags and scripts, keeps list items and breaks, decodes entities", () => {
    const html = `<h2>What's new</h2><ul><li>Faster <b>search</b></li><li>Fix &amp; polish &#x2014; &lt;tags&gt;</li></ul><script>alert(1)</script><p>Thanks<br>all</p>`;
    expect(notesText(html)).toBe("What's new\n\n• Faster search\n• Fix & polish — <tags>\n\nThanks\nall");
  });

  it("an image or a link never survives as markup", () => {
    expect(notesText(`<img src=x onerror="alert(1)">Hi <a href="javascript:alert(1)">there</a>`)).toBe("Hi there");
  });

  it("joins electron-updater's per-version notes, refuses control characters, and is bounded", () => {
    expect(notesText([{ version: "0.2.0", note: "A" }, { version: "0.1.9", note: "B&#0;" }])).toBe("A\n\nB");
    expect(notesText("x".repeat(5000)).length).toBe(4000);
    expect(notesText(null)).toBe("");
  });
});
