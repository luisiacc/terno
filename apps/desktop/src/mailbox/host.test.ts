import { describe, expect, it } from "vitest";
import type { MailboxGate } from "@terno/core/mailbox";
import { MailboxHost } from "./host";

function setup(o: { alive?: boolean } = {}) {
  const published: MailboxGate[] = [];
  let starts = 0;
  let alive = o.alive ?? false;
  const host = new MailboxHost({
    publish: (g) => published.push(g),
    start: () => {
      starts++;
      alive = true;
    },
    alive: () => alive,
  });
  return { host, published, starts: () => starts, die: () => (alive = false) };
}

const corrupt: MailboxGate = { kind: "failed", reason: "corrupt", step: null };

describe("main's mailbox gate (plan 95)", () => {
  it("a backend that explained its failure isn't restarted, and isn't a crash", () => {
    const t = setup({ alive: true });
    t.host.failed(3, { kind: "newer", schema: 40, supported: 38 });
    expect(t.published.at(-1)).toEqual({ kind: "newer", schema: 40, supported: 38 });
    expect(t.host.exited(3)).toBe(true);
    // another instance's exit is a crash, as before
    expect(t.host.exited(4)).toBe(false);
  });

  it("Try Again while the failed backend is still exiting starts a fresh one once it's gone, exactly once", () => {
    const t = setup({ alive: true });
    t.host.failed(1, corrupt);
    expect(t.host.retry()).toBe(true);
    expect(t.starts()).toBe(0);
    t.die();
    t.host.exited(1);
    expect(t.starts()).toBe(1);
  });

  it("Try Again after the failed backend is gone starts one at once (no room, a full disk freed)", () => {
    const t = setup();
    t.host.failed(1, { kind: "no-room", needBytes: 10, freeBytes: 1 });
    t.host.exited(1);
    expect(t.host.retry()).toBe(true);
    expect(t.starts()).toBe(1);
  });

  it("Try Again does nothing while the mailbox is open or being migrated", () => {
    const t = setup();
    expect(t.host.retry()).toBe(false);
    t.host.reported({ kind: "upgrading", from: 37, to: 38 });
    expect(t.host.retry()).toBe(false);
    expect(t.starts()).toBe(0);
  });

  it("a crash mid-upgrade steps the gate aside, so the restart policy (and the stopped-engine screen) take over (Codex review R6)", () => {
    const t = setup({ alive: true });
    t.host.reported({ kind: "upgrading", from: 37, to: 38 });
    expect(t.host.exited(9)).toBe(false);
    expect(t.published.at(-1)).toEqual({ kind: "open" });
  });
});
