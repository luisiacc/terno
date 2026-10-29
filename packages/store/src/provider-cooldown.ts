export const PROVIDER_COOLDOWN_KEY = "provider-cooldown:v1";
export const COOLDOWN_LEDGER_BYTES = 65_536;
export const COOLDOWN_CANDIDATE_BYTES = 131_072;
export const COOLDOWN_TICKETS = 64;
export const COOLDOWN_SERVICES = ["gmail-api", "oauth-token", "google-people", "google-userinfo"] as const;
export type CooldownService = typeof COOLDOWN_SERVICES[number];
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
export interface OpAdmission {
  blockedAccountIds: readonly number[];
  verifiedAccountIds: readonly number[];
  blockUnverifiedGoogle: boolean;
  blockAllGoogle: boolean;
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
    if (!record(r) || !keys(r, "owner,service,revision,phaseRevision,minimum,wall,replay,sample,position,hold,repair") || !(r.owner === "installation" || mailboxKeyValid(r.owner)) || !COOLDOWN_SERVICES.includes(r.service as CooldownService) || !decimal(r.revision) || !decimal(r.phaseRevision) || BigInt(r.phaseRevision) > BigInt(r.revision) || (r.minimum !== null && !minimum(r.minimum)) || (r.wall !== null && !minimum(r.wall)) || !decimal(r.replay) || BigInt(r.replay) > 17_280_000_000_360_000n || !integer(r.sample) || r.sample < 1600 || r.sample > 360000 || !integer(r.position) || r.position < 0 || r.position > 6 || ![null, "clock", "clock-evidence", "range", "calendar", "leap-second"].includes(r.hold as CooldownHold | null) || (r.repair !== null && (!decimal(r.repair) || BigInt(r.repair) >= BigInt(r.revision)))) return bad();
    const key = `${r.owner}/${r.service}`;
    if (seen.has(key) || BigInt(r.revision) > BigInt(v.revision)) return bad();
    seen.add(key);
  }
  const ids = new Set<number>();
  for (const b of v.bindings) {
    if (!record(b) || !keys(b, "id,createdAt,emailDigest,mailboxKey") || !integer(b.id) || b.id < 1 || !integer(b.createdAt) || !mailboxKeyValid(b.emailDigest) || !mailboxKeyValid(b.mailboxKey) || b.emailDigest !== b.mailboxKey || ids.has(b.id)) return bad();
    ids.add(b.id);
  }
  return v as unknown as CooldownLedger;
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
  if (old.hold && old.hold !== "clock") hold = old.hold;
  else if (candidate.hold && candidate.hold !== "clock") hold = candidate.hold;
  else if (old.hold === "clock" && candidate.hold === null && !(candidate.repair === old.revision && BigInt(candidate.revision) > BigInt(old.revision))) hold = "clock";
  else if (candidate.hold === "clock" && old.hold === null && !(old.repair === candidate.revision && BigInt(old.revision) > BigInt(candidate.revision))) hold = "clock";
  return { ...newer, phaseRevision: phaseOf(phase), sample: phase.sample, position: phase.position, minimum: max(old.minimum, candidate.minimum), replay: max(old.replay, candidate.replay)!, hold, repair: hold ? null : newer.repair };
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
  if (!input) return Object.freeze({ blockedAccountIds: Object.freeze([]), verifiedAccountIds: Object.freeze([]), blockUnverifiedGoogle: false, blockAllGoogle: false });
  if (typeof input.blockAllGoogle !== "boolean" || typeof input.blockUnverifiedGoogle !== "boolean") throw new Error("Invalid private admission");
  return Object.freeze({ blockedAccountIds: list(input.blockedAccountIds), verifiedAccountIds: list(input.verifiedAccountIds), blockUnverifiedGoogle: input.blockUnverifiedGoogle, blockAllGoogle: input.blockAllGoogle });
}
