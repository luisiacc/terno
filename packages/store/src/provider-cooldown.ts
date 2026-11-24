import { isOAuthKind, type OAuthKind } from "@terno/core";
export const PROVIDER_COOLDOWN_KEY = "provider-cooldown:v1";
export const COOLDOWN_LEDGER_BYTES = 65_536;
export const COOLDOWN_CANDIDATE_BYTES = 131_072;
export const COOLDOWN_TICKETS = 64;
export const COOLDOWN_SERVICES = ["gmail-api", "oauth-token", "google-userinfo"] as const;
/** plan 258: plan 22's People API, never asked since; a row a ledger kept for it still reads, and is dropped */
const RETIRED_SERVICES: readonly string[] = ["google-people"];
export type CooldownService = typeof COOLDOWN_SERVICES[number];
/** Plan 259: an OAuth provider's services in the ledger: its mail API, its token endpoint and its identity read. */
export type OAuthServices = { mail: "gmail-api"; token: "oauth-token"; identity: "google-userinfo" } & Record<"mail" | "token" | "identity", CooldownService>;
/**
 * The providers whose requests the ledger governs. Outlook's join with its Graph provider (plan 259 stage 2), so the
 * ledger never carries rows for services nothing asks yet; an account of a kind not here gets no request policy.
 */
export const OAUTH_SERVICES: Readonly<Partial<Record<OAuthKind, OAuthServices>>> = { gmail: { mail: "gmail-api", token: "oauth-token", identity: "google-userinfo" } };
export type CooldownHold = "clock" | "clock-evidence" | "range" | "calendar" | "leap-second";
export interface CooldownRow {
  owner: string;
  service: CooldownService;
  revision: string;
  phaseRevision?: string;
  minimum: string | null;
  wall: string | null;
  replay: string;
  sample: number;
  position: number;
  hold: CooldownHold | null;
  repair: string | null;
}
export interface CooldownBinding {
  id: number;
  createdAt: number;
  emailDigest: string;
  mailboxKey: string;
}
export interface CooldownLedger {
  version: 1;
  revision: string;
  overflow: boolean;
  bindings: CooldownBinding[];
  rows: CooldownRow[];
}
export interface CooldownStamp { id: number; email: string; createdAt: number }
export interface ProviderCooldownStore {
  read(): Promise<string | null>;
  update<R>(fn: (encoded: string | null) => { encoded: string; result: R }): Promise<R>;
  bind(stamp: CooldownStamp, mailboxKey: string, current?: () => boolean): Promise<boolean>;
}
/**
 * Plan 259: one OAuth provider's lanes, from its own cooldowns and the shared request capacity. `all`: none of its
 * accounts' ops run; `unverified`: only accounts in `verifiedAccountIds` run; `sends`/`background`: that lane waits.
 */
export interface KindAdmission {
  all: boolean;
  unverified: boolean;
  sends?: boolean;
  background?: boolean;
}

export interface OpAdmission {
  /** OAuth accounts whose ops wait (their mailbox is cooling down or paused) */
  blockedAccountIds: readonly number[];
  /** plan 107: accounts whose ops wait whatever their kind (a folder change holds its account's provider) */
  pausedAccountIds?: readonly number[];
  verifiedAccountIds: readonly number[];
  /** plan 259: per OAuth kind, so one provider's pause never holds another's ops; a kind not listed is admitted */
  kinds: Readonly<Partial<Record<OAuthKind, KindAdmission>>>;
}

const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v);
const minimum = (v: unknown): v is string => typeof v === "string" && /^-?(0|[1-9][0-9]{0,16})$/.test(v) && BigInt(v) >= -8_640_000_000_000_000n && BigInt(v) <= 8_640_000_000_000_000n;
export const mailboxKeyValid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string) => Object.keys(v).sort().join(",") === names.split(",").sort().join(",");
function bad(): never { throw new Error("Invalid private cooldown record"); }

export function decodeCooldown(encoded: string | null): CooldownLedger {
  if (encoded === null) return { version: 1, revision: "0", overflow: false, bindings: [], rows: [] };
  if (typeof encoded !== "string" || encoded.length > COOLDOWN_LEDGER_BYTES || bytes(encoded) > COOLDOWN_LEDGER_BYTES) return bad();
  let v: unknown;
  try { v = JSON.parse(encoded); } catch { return bad(); }
  if (!record(v) || !keys(v, "version,revision,overflow,bindings,rows") || v.version !== 1 || !decimal(v.revision) || typeof v.overflow !== "boolean" || !Array.isArray(v.rows) || !Array.isArray(v.bindings)) return bad();
  // Leave representational room for all 64 responses already admitted by the current owner.
  if (BigInt(v.revision) > 99_999_999_999_999_999_935n) return bad();
  const seen = new Set<string>();
  for (const r of v.rows) {
    if (!record(r) || !keys(r, "owner,service,revision,phaseRevision,minimum,wall,replay,sample,position,hold,repair") || !(r.owner === "installation" || mailboxKeyValid(r.owner)) || !(COOLDOWN_SERVICES.includes(r.service as CooldownService) || RETIRED_SERVICES.includes(r.service as string)) || !decimal(r.revision) || !decimal(r.phaseRevision) || BigInt(r.phaseRevision) > BigInt(r.revision) || (r.minimum !== null && !minimum(r.minimum)) || (r.wall !== null && !minimum(r.wall)) || !decimal(r.replay) || BigInt(r.replay) > 17_280_000_000_360_000n || !integer(r.sample) || r.sample < 1600 || r.sample > 360000 || !integer(r.position) || r.position < 0 || r.position > 6 || ![null, "clock", "clock-evidence", "range", "calendar", "leap-second"].includes(r.hold as CooldownHold | null) || (r.repair !== null && (!decimal(r.repair) || BigInt(r.repair) >= BigInt(r.revision)))) return bad();
    const key = `${r.owner}/${r.service}`;
    if (seen.has(key) || BigInt(r.revision) > BigInt(v.revision)) return bad();
    seen.add(key);
  }
  const ids = new Set<number>();
  for (const b of v.bindings) {
    if (!record(b) || !keys(b, "id,createdAt,emailDigest,mailboxKey") || !integer(b.id) || b.id < 1 || !integer(b.createdAt) || !mailboxKeyValid(b.emailDigest) || !mailboxKeyValid(b.mailboxKey) || b.emailDigest !== b.mailboxKey || ids.has(b.id)) return bad();
    ids.add(b.id);
  }
  const ledger = v as unknown as CooldownLedger;
  return ledger.rows.some((r) => RETIRED_SERVICES.includes(r.service)) ? { ...ledger, rows: ledger.rows.filter((r) => !RETIRED_SERVICES.includes(r.service)) } : ledger;
}

export function encodeCooldown(ledger: CooldownLedger): string {
  let encoded: string;
  try { encoded = JSON.stringify(ledger); } catch { return bad(); }
  decodeCooldown(encoded);
  return encoded;
}
export function nextCooldownRevision(revision: string): string {
  const next = (BigInt(revision) + 1n).toString();
  if (!decimal(next)) return bad();
  return next;
}
export async function mailboxDigest(email: string, hashBytes: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>): Promise<string> {
  const encoded = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await hashBytes(Uint8Array.from(encoded));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function phaseOf(row: CooldownRow): string {
  if (!decimal(row.phaseRevision) || BigInt(row.phaseRevision) > BigInt(row.revision)) return bad();
  return row.phaseRevision;
}
export function mergeCooldownRows(old: CooldownRow | undefined, candidate: CooldownRow): CooldownRow {
  const candidatePhase = phaseOf(candidate);
  if (!old) return { ...candidate, phaseRevision: candidatePhase };
  const oldPhase = phaseOf(old);
  if (oldPhase === candidatePhase && (old.sample !== candidate.sample || old.position !== candidate.position)) return bad();
  const phase = BigInt(oldPhase) > BigInt(candidatePhase) ? old : candidate;
  const newer = BigInt(old.revision) > BigInt(candidate.revision) ? old : candidate;
  const max = (a: string | null, b: string | null) => a === null ? b : b === null ? a : BigInt(a) >= BigInt(b) ? a : b;
  let hold = newer.hold;
  // A row fenced at or after the other's revision accounts for it (plan 264: "at or after", so a repair of a later
  // in-memory hold, one that never reached disk, still covers the saved one): a repair (Check clock, or a start lifting
  // a hold) may clear any hold it covers, and its minimum and replay stand (a success retiring a met pause sets them to
  // now and 0; Check clock, a start's lift and a 429 carrying the fence on never lower them, so for those this is the max)
  const covers = (a: CooldownRow, b: CooldownRow) => a.repair !== null && BigInt(b.revision) <= BigInt(a.repair) && BigInt(a.revision) > BigInt(b.revision);
  if (old.hold && old.hold !== "clock" && !covers(candidate, old)) hold = old.hold;
  else if (candidate.hold && candidate.hold !== "clock" && !covers(old, candidate)) hold = candidate.hold;
  else if (old.hold === "clock" && candidate.hold === null && !covers(candidate, old)) hold = "clock";
  else if (candidate.hold === "clock" && old.hold === null && !covers(old, candidate)) hold = "clock";
  const replay = covers(candidate, old) ? candidate.replay : covers(old, candidate) ? old.replay : max(old.replay, candidate.replay)!;
  const minimum = covers(candidate, old) ? candidate.minimum : covers(old, candidate) ? old.minimum : max(old.minimum, candidate.minimum);
  return { ...newer, phaseRevision: phaseOf(phase), sample: phase.sample, position: phase.position, minimum, replay, hold, repair: hold ? null : newer.repair };
}

/** plan 264: a row whose pause is over and that carries nothing forward: the same as no row */
export const cooldownRetired = (row: CooldownRow, wall: number): boolean =>
  row.hold === null && row.position === 0 && row.replay === "0" && row.minimum !== null && BigInt(row.minimum) <= BigInt(wall);

const WORST_ROW: CooldownRow = { owner: "f".repeat(64), service: "google-userinfo", revision: "9".repeat(20), phaseRevision: "9".repeat(20), minimum: "-8640000000000000", wall: "-8640000000000000", replay: "17280000000360000", sample: 360000, position: 6, hold: "clock-evidence", repair: "9".repeat(20) };
/** plan 264: what a start waits, for every Google service, once it clears an overflow (a refusal it lost may be in it) */
export const OVERFLOW_QUARANTINE_MS = 3_600_000;

/**
 * Plan 264: a start's compaction, inside the adapter's transaction. Drops bindings of accounts that no longer exist and
 * retired rows (identical to no row); any other row stays, bound or not. An overflow lost a refusal it couldn't write:
 * it is cleared only when what is left, plus a worst-case row for every service each remaining owner lacks, fits with
 * the overflow envelope's room, and then every Google service waits OVERFLOW_QUARANTINE_MS from this start, at the
 * installation (every account), in place of what was lost.
 */
export function compactCooldown(encoded: string | null, live: (id: number, createdAt: number) => boolean, wall: number): string {
  const ledger = decodeCooldown(encoded);
  const valid = Number.isSafeInteger(wall) && Math.abs(wall) <= 8_640_000_000_000_000 - OVERFLOW_QUARANTINE_MS;
  ledger.bindings = ledger.bindings.filter((b) => live(b.id, b.createdAt));
  if (valid) ledger.rows = ledger.rows.filter((row) => !cooldownRetired(row, wall));
  if (ledger.overflow && valid) {
    const bound = new Set(ledger.bindings.map((b) => b.mailboxKey));
    const worst = bytes(JSON.stringify(WORST_ROW)) + 1;
    let missing = 0;
    for (const owner of ["installation", ...bound]) for (const service of COOLDOWN_SERVICES) if (!ledger.rows.some((r) => r.owner === owner && r.service === service)) missing++;
    if (bytes(encodeCooldown({ ...ledger, overflow: false })) + missing * worst <= COOLDOWN_LEDGER_BYTES - 128) {
      ledger.overflow = false;
      for (const service of COOLDOWN_SERVICES) {
        ledger.revision = nextCooldownRevision(ledger.revision);
        const old = ledger.rows.find((r) => r.owner === "installation" && r.service === service);
        const quarantine: CooldownRow = { owner: "installation", service, revision: ledger.revision, phaseRevision: ledger.revision, minimum: String(wall + OVERFLOW_QUARANTINE_MS), wall: String(wall), replay: String(OVERFLOW_QUARANTINE_MS), sample: 360000, position: 6, hold: null, repair: null };
        ledger.rows = ledger.rows.filter((r) => r !== old);
        ledger.rows.push(mergeCooldownRows(old, quarantine));
      }
    }
  }
  return encodeCooldown(ledger);
}

/** Called inside the adapter's existing synchronous transaction. */
export function bindCooldown(encoded: string | null, stamp: CooldownStamp, emailDigest: string, mailboxKey: string): string {
  if (!mailboxKeyValid(mailboxKey) || !mailboxKeyValid(emailDigest) || mailboxKey !== emailDigest) return bad();
  const ledger = decodeCooldown(encoded);
  ledger.bindings = ledger.bindings.filter((b) => b.id !== stamp.id);
  ledger.bindings.push({ id: stamp.id, createdAt: stamp.createdAt, emailDigest, mailboxKey });
  for (const installation of ledger.rows.filter((r) => r.owner === "installation")) {
    const old = ledger.rows.find((r) => r.owner === mailboxKey && r.service === installation.service);
    const inherited = mergeCooldownRows(old, { ...installation, owner: mailboxKey, repair: null });
    ledger.rows = ledger.rows.filter((r) => r.owner !== mailboxKey || r.service !== installation.service);
    ledger.rows.push(inherited);
  }
  ledger.revision = nextCooldownRevision(ledger.revision);
  for (const row of ledger.rows) if (row.owner === mailboxKey) row.revision = ledger.revision;
  try {
    // Leave room for the overflow envelope on the next observation.
    const result = encodeCooldown(ledger);
    if (bytes(result) > COOLDOWN_LEDGER_BYTES - 128) throw new Error("Private cooldown capacity");
    return result;
  } catch {
    const previous = decodeCooldown(encoded);
    previous.overflow = true;
    previous.revision = nextCooldownRevision(previous.revision);
    return encodeCooldown(previous);
  }
}

/** Copy before an IDB command queues; two constant-count SQL JSON parameters. */
export function copyOpAdmission(input?: OpAdmission): OpAdmission {
  const list = (v: readonly number[]) => {
    if (v.length > Math.floor((COOLDOWN_LEDGER_BYTES - 1) / 2)) throw new Error("Private admission capacity");
    let encodedBytes = 1;
    for (const n of v) {
      if (!integer(n) || n < 1) throw new Error("Invalid private admission");
      encodedBytes += String(n).length + 1;
      if (encodedBytes > COOLDOWN_LEDGER_BYTES) throw new Error("Private admission capacity");
    }
    const result = [...new Set(v)];
    result.sort((a, b) => a - b);
    if (bytes(JSON.stringify(result)) > 65_536) throw new Error("Private admission capacity");
    return Object.freeze(result);
  };
  if (!input) return Object.freeze({ blockedAccountIds: Object.freeze([]), verifiedAccountIds: Object.freeze([]), kinds: Object.freeze({}) });
  if (!input.kinds || typeof input.kinds !== "object") throw new Error("Invalid private admission");
  const kinds: Partial<Record<OAuthKind, KindAdmission>> = {};
  for (const [kind, lanes] of Object.entries(input.kinds) as [string, KindAdmission | undefined][]) {
    if (!isOAuthKind(kind)) throw new Error("Invalid private admission");
    if (!lanes) continue;
    if (typeof lanes.all !== "boolean" || typeof lanes.unverified !== "boolean") throw new Error("Invalid private admission");
    if ((lanes.sends !== undefined && typeof lanes.sends !== "boolean") || (lanes.background !== undefined && typeof lanes.background !== "boolean")) throw new Error("Invalid private lane admission");
    kinds[kind] = Object.freeze({ all: lanes.all, unverified: lanes.unverified, sends: lanes.sends, background: lanes.background });
  }
  return Object.freeze({ ...(input.pausedAccountIds?.length && { pausedAccountIds: list(input.pausedAccountIds) }), blockedAccountIds: list(input.blockedAccountIds), verifiedAccountIds: list(input.verifiedAccountIds), kinds: Object.freeze(kinds) });
}

/**
 * Whether an op may run under an admission: a paused account's never; an OAuth account's when it isn't blocked and its
 * kind's lanes let it (plan 259: per kind); anything else's always. The SQL store states the same rule in its claim.
 */
export function opAdmitter(input?: OpAdmission): (accountId: number, accountKind: string | undefined, opKind: string) => boolean {
  const a = copyOpAdmission(input);
  const blocked = new Set(a.blockedAccountIds), verified = new Set(a.verifiedAccountIds), paused = new Set(a.pausedAccountIds);
  return (id, kind, op) => {
    if (paused.has(id)) return false;
    if (!isOAuthKind(kind)) return true;
    if (blocked.has(id)) return false;
    const lanes = a.kinds[kind];
    return !lanes || (!lanes.all && !(op === "send" ? lanes.sends : lanes.background) && (!lanes.unverified || verified.has(id)));
  };
}
