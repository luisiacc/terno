/**
 * Plan 20: main tells the backend when the network changed (a VPN on or off, another Wi-Fi, a
 * wake), so mail resumes in seconds instead of waiting minutes on sockets that died silently.
 *
 * macOS: `scutil` watching the dynamic store, which configd updates when the primary service or
 * its routes change (VPN services publish their IPv4 and DNS there), when any interface gains or
 * loses an address (KernelEventMonitor: utun included, so wg-quick and OpenVPN too), and when DNS
 * changes. It blocks in its run loop until something changes (no CPU while nothing does) and
 * exits by itself when its stdin closes, so it never outlives main. The routing socket (`route
 * monitor`) sees everything too, but posts every failed lookup (thousands a minute on a busy Mac).
 *
 * Elsewhere: wake from sleep only (macOS first).
 */
import type { NetworkInterfaceInfo } from "node:os";

export type WatchReason = "network" | "wake" | "online" | "offline";

export interface NetworkWatchChange {
  online: boolean;
  reason: WatchReason;
}

interface ChildLike {
  pid?: number;
  stdin: { write(s: string): unknown; end(): unknown; on(e: "error", l: () => void): unknown } | null;
  stdout: { setEncoding(e: "utf8"): unknown; on(e: "data", l: (chunk: string) => void): unknown } | null;
  on(e: "exit", l: (code: number | null) => void): unknown;
  on(e: "error", l: (error: Error & { code?: string }) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface NetworkWatchDeps {
  platform: NodeJS.Platform;
  spawn(command: string, args: string[], options: { stdio: ["pipe", "pipe", "ignore"] }): ChildLike;
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  isOnline(): boolean;
  onChange(change: NetworkWatchChange): void;
  /** the watcher stopped unexpectedly; `gaveUp`: it won't be started again this session */
  onFailure?(failure: { errno?: string; exitCode: number | null; attempt: number; gaveUp: boolean }): void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
}

export const SCUTIL = "/usr/sbin/scutil";
/** what scutil watches: the primary service and DNS, every service's addresses and DNS, every interface's addresses */
export const SCUTIL_SCRIPT = [
  "n.add State:/Network/Global/IPv4",
  "n.add State:/Network/Global/IPv6",
  "n.add State:/Network/Global/DNS",
  "n.add State:/Network/Service/[^/]+/IPv4 pattern",
  "n.add State:/Network/Service/[^/]+/IPv6 pattern",
  "n.add State:/Network/Service/[^/]+/DNS pattern",
  "n.add State:/Network/Interface/[^/]+/IPv4 pattern",
  "n.add State:/Network/Interface/[^/]+/IPv6 pattern",
  "n.watch",
  "",
].join("\n");

/** a burst (a VPN connect posts several keys within ~100 ms) settles this long after its last key… */
export const DEBOUNCE_MS = 750;
/** …but never later than this after its first */
export const MAX_WAIT_MS = 3000;
const RESTART_MS = 1000;
const RESTART_MAX_MS = 5 * 60_000;
/** up this long, the watcher's earlier failures are forgotten */
const HEALTHY_MS = 10 * 60_000;
const MAX_FAILURES = 8;

/** AirDrop, peer-to-peer and virtual links churn their link-local addresses: never a network change */
const IGNORED_IF = /^(awdl|llw|anpi|ap|bridge|gif|stf|lo)\d*$/;

/** The dynamic-store keys a chunk of `scutil` output names as changed ("changedKey [0] = State:/…"). */
export function changedKeys(text: string): string[] {
  return [...text.matchAll(/changed ?[Kk]ey \[\d+\] = (\S+)/g)].map((m) => m[1]!);
}

/** "global": always a change (primary service, routes, DNS); "interface": only if addresses changed; null: noise. */
export function keyKind(key: string): "global" | "interface" | null {
  if (key.startsWith("State:/Network/Global/") || key.startsWith("State:/Network/Service/")) return "global";
  const m = /^State:\/Network\/Interface\/([^/]+)\/(IPv4|IPv6)$/.exec(key);
  if (m) return IGNORED_IF.test(m[1]!) ? null : "interface";
  return null;
}

/** The addresses that can carry mail: non-internal, not link-local, on interfaces that aren't ignored. */
export function fingerprint(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (IGNORED_IF.test(name)) continue;
    for (const a of list ?? []) if (!a.internal && !/^fe80:/i.test(a.address) && !a.address.startsWith("169.254.")) out.push(`${name}/${a.family}/${a.address}`);
  }
  return out.sort().join(",");
}

export class NetworkWatch {
  private child: ChildLike | null = null;
  private buffer = "";
  private stopped = true;
  private failures = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private burstStart = 0;
  private burstGlobal = false;
  private print = "";
  private online = true;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: NetworkWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((t) => clearTimeout(t));
  }

  /** the watcher's process (the packaged smoke checks it), or null */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.print = fingerprint(this.deps.interfaces());
    this.online = this.deps.isOnline();
    if (this.deps.platform === "darwin") this.spawn();
  }

  /** the Mac woke up: every socket from before the sleep is suspect */
  wake(): void {
    if (this.stopped) return;
    this.print = fingerprint(this.deps.interfaces());
    this.online = this.deps.isOnline();
    this.deps.onChange({ online: this.online, reason: "wake" });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    if (this.debounce) this.clearTimer(this.debounce);
    this.restartTimer = this.debounce = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    // its stdin closing ends it on its own; SIGTERM to the PID we spawned makes sure
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    child.kill("SIGTERM");
  }

  /** feeds `scutil` output (tests call it directly) */
  feed(text: string): void {
    this.buffer += text;
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) return;
    const lines = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    let relevant = false;
    for (const key of changedKeys(lines)) {
      const kind = keyKind(key);
      if (!kind) continue;
      relevant = true;
      if (kind === "global") this.burstGlobal = true;
    }
    if (relevant) this.schedule();
  }

  private schedule(): void {
    const now = this.now();
    if (!this.debounce) this.burstStart = now;
    else this.clearTimer(this.debounce);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.burstStart + MAX_WAIT_MS - now));
    this.debounce = this.setTimer(() => this.settle(), wait);
  }

  private settle(): void {
    this.debounce = null;
    if (this.stopped) return;
    const global = this.burstGlobal;
    this.burstGlobal = false;
    const print = fingerprint(this.deps.interfaces());
    const online = this.deps.isOnline();
    const changed = global || print !== this.print;
    const flipped = online !== this.online;
    this.print = print;
    this.online = online;
    if (changed) this.deps.onChange({ online, reason: "network" });
    else if (flipped) this.deps.onChange({ online, reason: online ? "online" : "offline" });
  }

  private spawn(): void {
    let child: ChildLike;
    try {
      child = this.deps.spawn(SCUTIL, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      return this.failed(null, null, (error as { code?: string }).code);
    }
    this.child = child;
    this.startedAt = this.now();
    this.buffer = "";
    child.on("error", (error) => this.failed(child, null, error.code));
    child.on("exit", (code) => this.failed(child, code));
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.feed(chunk));
    child.stdin?.write(SCUTIL_SCRIPT);
  }

  /** the child failed to start or exited: start it again after a backoff, or give up */
  private failed(child: ChildLike | null, exitCode: number | null, errno?: string): void {
    if (this.stopped || (child && child !== this.child)) return;
    this.child = null;
    if (this.now() - this.startedAt > HEALTHY_MS) this.failures = 0;
    this.failures++;
    const gaveUp = errno === "ENOENT" || errno === "EACCES" || this.failures >= MAX_FAILURES;
    this.deps.onFailure?.({ errno, exitCode, attempt: this.failures, gaveUp });
    if (gaveUp) return;
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawn();
    }, Math.min(RESTART_MS * 2 ** (this.failures - 1), RESTART_MAX_MS));
  }
}
