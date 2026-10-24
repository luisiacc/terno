import type { OwnerIdentity } from "@terno/core/rpc";
import type { OwnerClaim } from "@terno/store";
import type { Db } from "./sqlite";

export type { OwnerClaim } from "@terno/store";


interface OwnerRow {
  user_id: string;
  email: string;
  display_name: string;
  provider: "gmail" | "imap";
  verified_by: "google_oauth" | "imap_login";
  evidence_json: string;
  verified_at: number | null;
  account_id: number | null;
  created_at: number;
  updated_at: number;
}

export function getOwner(db: Db): OwnerIdentity | null {
  const r = db.get<OwnerRow>("SELECT * FROM owner WHERE id = 1");
  if (!r) return null;
  return {
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    provider: r.provider,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
    migrated: (JSON.parse(r.evidence_json) as { migrated?: boolean }).migrated === true,
    accountId: r.account_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** First verified account wins: INSERT OR IGNORE on the singleton row makes concurrent claims race-free. */
export function claimOwner(db: Db, claim: OwnerClaim, now = Date.now()): boolean {
  return (
    db.run(
      `INSERT OR IGNORE INTO owner (id, user_id, email, display_name, provider, verified_by, evidence_json, verified_at, account_id, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.uuid(),
      claim.email.toLowerCase(),
      claim.displayName,
      claim.provider,
      claim.verifiedBy,
      JSON.stringify(claim.evidence),
      now,
      claim.accountId,
      now,
      now,
    ).changes === 1
  );
}

/** Moves ownership to a freshly re-verified account. The user id is stable; the previous owner goes to history. */
export function changeOwner(db: Db, claim: OwnerClaim, reason: string, now = Date.now()): void {
  db.tx(() => {
    const changed = db.run(
      `INSERT INTO owner_history (user_id, email, provider, verified_by, evidence_json, verified_at, replaced_at, reason)
       SELECT user_id, email, provider, verified_by, evidence_json, verified_at, ?, ? FROM owner WHERE id = 1`,
      now,
      reason,
    ).changes;
    if (changed === 0) {
      claimOwner(db, claim, now);
      return;
    }
    db.run(
      `UPDATE owner SET email = ?, display_name = ?, provider = ?, verified_by = ?, evidence_json = ?, verified_at = ?, account_id = ?, updated_at = ? WHERE id = 1`,
      claim.email.toLowerCase(),
      claim.displayName,
      claim.provider,
      claim.verifiedBy,
      JSON.stringify(claim.evidence),
      now,
      claim.accountId,
      now,
    );
  });
}

export function ownerHistory(db: Db): { userId: string; email: string; provider: string; replacedAt: number; reason: string }[] {
  return db.all("SELECT user_id AS userId, email, provider, replaced_at AS replacedAt, reason FROM owner_history ORDER BY id");
}
