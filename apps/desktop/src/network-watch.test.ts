import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changedKeys, DEBOUNCE_MS, fingerprint, keyKind, MAX_WAIT_MS, NetworkWatch, SCUTIL, SCUTIL_SCRIPT, type NetworkWatchChange } from "./network-watch";

/**
 * What scutil printed on this Mac when a full-tunnel VPN on utun9 disconnected (plan 20's passive
 * log, 2026-10-25): its routes went, then configd posted these keys within ~50 ms.
 */
const VPN_DOWN = [
  "notification callback (store address = 0x100ad5e00).\n",
  "  17:52:09.330 changedKey [0] = State:/Network/Global/IPv4\n  17:52:09.331 (+0.001) changedKey [1] = State:/Network/Global/DNS\n",
  "notification callback (store address = 0x100ad5e00).\n",
  "  17:52:09.351 (+0.020) changedKey [0] = State:/Network/Interface/utun9/IPv4\n",
];

const addr = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as unknown as NetworkInterfaceInfo;
const WITH_VPN = { lo0: [addr("127.0.0.1", "IPv4", true)], en0: [addr("192.168.0.102"), addr("fe80::1", "IPv6")], utun9: [addr("172.27.232.109")], awdl0: [addr("fe80::2", "IPv6")] };
const WITHOUT_VPN = { lo0: WITH_VPN.lo0, en0: WITH_VPN.en0, awdl0: [addr("fe80::3", "IPv6")] };

class FakeChild extends EventEmitter {
  static seq = 100;
  pid = FakeChild.seq++;
  written = "";
  ended = false;
  killed: string | null = null;
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => void (this.written += s),
    end: () => void (this.ended = true),
  });
  kill(signal?: string) {
    this.killed = signal ?? "SIGTERM";
  }
}

function rig(o: { platform?: NodeJS.Platform; online?: () => boolean } = {}) {
  let ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = WITH_VPN;
  const children: FakeChild[] = [];
  const spawns: string[] = [];
  const changes: NetworkWatchChange[] = [];
  const failures: unknown[] = [];
  const watch = new NetworkWatch({
    platform: o.platform ?? "darwin",
    spawn: (command) => {
      spawns.push(command);
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    interfaces: () => ifaces,
    isOnline: o.online ?? (() => true),
    onChange: (c) => changes.push(c),
    onFailure: (f) => failures.push(f),
  });
  const say = (text: string) => children.at(-1)!.stdout.emit("data", text);
  return { watch, children, spawns, changes, failures, say, setIfaces: (i: typeof ifaces) => (ifaces = i) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parsing scutil (plan 20)", () => {
  it("reads the changed keys of real output, old and new spellings", () => {
    expect(changedKeys(VPN_DOWN.join(""))).toEqual(["State:/Network/Global/IPv4", "State:/Network/Global/DNS", "State:/Network/Interface/utun9/IPv4"]);
    expect(changedKeys("  changed key [0] = State:/Network/Global/IPv4\n")).toEqual(["State:/Network/Global/IPv4"]);
    expect(changedKeys("notification callback (store address = 0x1).\n")).toEqual([]);
  });

  it("global and service keys always count, interface keys only for real links, the rest is noise", () => {
    expect(keyKind("State:/Network/Global/IPv4")).toBe("global");
    expect(keyKind("State:/Network/Service/58769497-3CDB-4B05/DNS")).toBe("global");
    expect(keyKind("State:/Network/Interface/utun9/IPv4")).toBe("interface");
    expect(keyKind("State:/Network/Interface/en0/IPv6")).toBe("interface");
    for (const noisy of ["awdl0", "llw0", "anpi1", "ap1", "bridge0", "lo0"]) expect(keyKind(`State:/Network/Interface/${noisy}/IPv6`), noisy).toBeNull();
    expect(keyKind("State:/Network/Interface/en0/Link")).toBeNull();
  });

  it("fingerprints only addresses that can carry mail", () => {
    expect(fingerprint(WITH_VPN)).toBe("en0/IPv4/192.168.0.102,utun9/IPv4/172.27.232.109");
    expect(fingerprint(WITHOUT_VPN)).toBe("en0/IPv4/192.168.0.102");
    // AirDrop's link-local churn changes nothing
    expect(fingerprint({ ...WITH_VPN, awdl0: [addr("fe80::9", "IPv6")] })).toBe(fingerprint(WITH_VPN));
  });
});

describe("NetworkWatch (plan 20)", () => {
  it("spawns scutil with the watch script and keeps its stdin open", () => {
    const t = rig();
    t.watch.start();
    expect(t.spawns).toEqual([SCUTIL]);
    expect(t.children[0]!.written).toBe(SCUTIL_SCRIPT);
    expect(t.children[0]!.ended).toBe(false);
    expect(t.watch.pid).toBe(t.children[0]!.pid);
  });

  it("the real VPN disconnect: one change, after the burst settles", () => {
    const t = rig();
    t.watch.start();
    t.setIfaces(WITHOUT_VPN);
    for (const chunk of VPN_DOWN) t.say(chunk);
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(t.changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.changes).toEqual([{ online: true, reason: "network" }]);
  });

  it("a global key counts even when no address changed (a VPN exit node: routes only)", () => {
    const t = rig();
    t.watch.start();
    t.say("  changedKey [0] = State:/Network/Service/ABC/IPv4\n");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(t.changes).toHaveLength(1);
  });

  it("an interface key without an address change is nothing; noise keys never wake it", () => {
    const t = rig();
    t.watch.start();
    t.say("  changedKey [0] = State:/Network/Interface/en0/IPv6\n");
    t.say("  changedKey [0] = State:/Network/Interface/awdl0/IPv6\n");
    vi.advanceTimersByTime(10_000);
    expect(t.changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a line split across chunks is read whole", () => {
    const t = rig();
    t.watch.start();
    t.say("  changedKey [0] = State:/Network/Glo");
    t.say("bal/IPv4\n");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(t.changes).toHaveLength(1);
  });

  it("an endless burst still reports by the max wait", () => {
    const t = rig();
    t.watch.start();
    for (let ms = 0; ms < MAX_WAIT_MS + 500; ms += 200) {
      t.say("  changedKey [0] = State:/Network/Global/DNS\n");
      vi.advanceTimersByTime(200);
    }
    expect(t.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("online flipping with no key that counts is still told (online/offline)", () => {
    let online = true;
    const t = rig({ online: () => online });
    t.watch.start();
    online = false;
    t.say("  changedKey [0] = State:/Network/Interface/en0/IPv4\n");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(t.changes).toEqual([{ online: false, reason: "offline" }]);
  });

  it("a wake is told at once", () => {
    const t = rig();
    t.watch.start();
    t.watch.wake();
    expect(t.changes).toEqual([{ online: true, reason: "wake" }]);
  });

  it("a watcher that dies is started again with a backoff; one that keeps dying is given up", () => {
    const t = rig();
    t.watch.start();
    t.children[0]!.emit("exit", 1);
    expect(t.children).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(t.children).toHaveLength(2);
    t.children[1]!.emit("exit", null);
    vi.advanceTimersByTime(1999);
    expect(t.children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.children).toHaveLength(3);
    for (let i = 0; i < 10; i++) {
      t.children.at(-1)!.emit("exit", 1);
      vi.advanceTimersByTime(5 * 60_000);
    }
    expect(t.children).toHaveLength(8);
    expect(t.failures.at(-1)).toMatchObject({ attempt: 8, gaveUp: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no scutil at all: given up at once", () => {
    const t = rig();
    t.watch.start();
    t.children[0]!.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    t.children[0]!.emit("exit", null);
    vi.advanceTimersByTime(60_000);
    expect(t.children).toHaveLength(1);
    expect(t.failures).toEqual([{ errno: "ENOENT", exitCode: null, attempt: 1, gaveUp: true }]);
  });

  it("stop ends the child (stdin closed, SIGTERM to its PID) and nothing restarts it", () => {
    const t = rig();
    t.watch.start();
    t.say("  changedKey [0] = State:/Network/Global/IPv4\n");
    t.watch.stop();
    expect(t.children[0]!.ended).toBe(true);
    expect(t.children[0]!.killed).toBe("SIGTERM");
    t.children[0]!.emit("exit", null);
    vi.advanceTimersByTime(600_000);
    expect(t.children).toHaveLength(1);
    expect(t.changes).toEqual([]);
    expect(t.watch.pid).toBeNull();
  });

  it("other platforms: no child, wake only", () => {
    const t = rig({ platform: "linux" });
    t.watch.start();
    expect(t.spawns).toEqual([]);
    t.watch.wake();
    expect(t.changes).toEqual([{ online: true, reason: "wake" }]);
  });
});
