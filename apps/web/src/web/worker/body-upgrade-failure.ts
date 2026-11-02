import { UncertainWriteError } from "@terno/idb/uncertainty";

/** What the upgrade worker may say about a refused open: fixed classifications, never mail or error text. */
export type BodyUpgradeFailure = "uncertain-dirty" | "uncertain-unreadable" | "newer";

export function classifyUpgradeFailure(error: unknown): BodyUpgradeFailure | undefined {
  if (error instanceof UncertainWriteError) return error.reason === "dirty" ? "uncertain-dirty" : "uncertain-unreadable";
  if (error instanceof Error && /newer than this app/.test(error.message)) return "newer";
  return undefined;
}
