import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { Loader2 } from "@terno/ui/icons";
import { windowLabel } from "~/lib/settings-values";
import { useApp } from "~/state/app";

/**
 * Plan 79: an account's first pass is running (it never finished one). Not while it can't reach its server, needs a
 * sign-in or failed: the connection pill and the sign-in notice speak then, and this comes back with the retry.
 */
export function firstSyncing(a: Account): boolean {
  const s = a.syncState;
  return s.status === "syncing" && s.lastSyncAt === null && !s.connection && !s.authRequired;
}

/**
 * Plan 101: an account's widened window is still downloading its older mail. Like a first sync, not while it can't
 * reach its server, needs a sign-in or failed (those speak then); a first sync's pill wins over it.
 */
export function backfilling(a: Account): boolean {
  const s = a.syncState;
  return a.backfillSince != null && s.status !== "error" && !s.connection && !s.authRequired && !firstSyncing(a);
}

/** Plan 79: the sidebar says, quietly, that a new account's mail is still coming in; plan 101: or its older mail. */
export function FirstSyncPill() {
  const accounts = useApp((s) => s.accounts);
  const general = useApp((s) => s.settings?.syncWindowDays ?? 180);
  const first = accounts.filter(firstSyncing);
  const older = first.length ? [] : accounts.filter(backfilling);
  const syncing = first.length ? first : older;
  if (!syncing.length) return null;
  const detail = syncing.length === 1 ? t("firstSync.detail", { window: windowLabel(syncing[0]!.syncWindowDays ?? general) }) : t("firstSync.accounts", { count: syncing.length });
  return (
    <div className="flex shrink-0 px-2 pt-1" data-testid="first-sync-pill">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-sidebar-border py-1.5 pr-2 pl-2.5 text-xs">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0 flex-1 leading-tight">
          <p role="status" className="truncate font-medium text-sidebar-foreground">
            {first.length ? t("firstSync.title") : t("firstSync.older")}
          </p>
          <p className="truncate text-muted-foreground" data-testid="first-sync-detail">
            {detail}
          </p>
        </div>
      </div>
    </div>
  );
}
