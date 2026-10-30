import type { OpRow } from "./types";

type SubmissionOp = Pick<OpRow, "kind" | "target_json">;

/** Provider acceptance is submission proof, independent of recipients and Sent-copy history. */
export function submissionAccepted(op: SubmissionOp | null): boolean {
  return op?.kind === "send" && JSON.parse(op.target_json).submissionAccepted === true;
}

export function acceptedSubmissionTarget(op: SubmissionOp): string {
  return JSON.stringify({ ...JSON.parse(op.target_json), submissionAccepted: true });
}
