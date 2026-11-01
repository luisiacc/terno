import type { Account, SyncProgress } from "@terno/core";
import { formatNumber, t } from "@terno/i18n";
import { ChevronDown, Loader2 } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useId, useState } from "react";
import { windowLabel } from "~/lib/settings-values";
import { useApp } from "~/state/app";

const DAY = 86_400_000;

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

/**
 * Plan 103: what's left of an account's sync, as well as its provider can say: messages (Gmail's estimate, so
 * "about"), folders (IMAP), else the days between the oldest mail reached and where it stops; and how far along
 * (null: unknown, the bar only shows it's working).
 */
export function syncLeft(p: SyncProgress | null | undefined, stopsAt: number): { label: string; short: string; fraction: number | null } {
  if (p?.finishing) return { label: t("firstSync.finishing"), short: t("firstSync.finishing"), fraction: 1 };
  if (p?.total && p.done !== undefined) {
    const left = Math.max(0, p.total - p.done);
    const fraction = Math.min(1, p.done / p.total);
    if (p.unit === "folders") return { label: t("firstSync.foldersLeft", { count: left }), short: t("firstSync.foldersLeft", { count: left }), fraction };
    // the row says it short; the bar's name says it whole
    return { label: t("firstSync.messagesLeft", { count: left }), short: t("firstSync.messagesLeftShort", { count: formatNumber(left) }), fraction };
  }
  if (p?.reachedAt !== undefined) {
    const days = Math.max(0, Math.ceil((p.reachedAt - stopsAt) / DAY));
    const span = Date.now() - stopsAt;
    const label = t("firstSync.daysLeft", { count: days });
    return { label, short: label, fraction: span > 0 ? Math.min(1, Math.max(0, (Date.now() - p.reachedAt) / span)) : null };
  }
  return { label: t("firstSync.starting"), short: t("firstSync.starting"), fraction: null };
}

/**
 * Plan 79: the sidebar says, quietly, that a new account's mail is still coming in; plan 101: or its older mail.
 * Plan 103: a click opens it to each account's progress (a caret says so on hover), and closes it again.
 */
export function FirstSyncPill() {
  const accounts = useApp((s) => s.accounts);
  const general = useApp((s) => s.settings?.syncWindowDays ?? 180);
  const [open, setOpen] = useState(false);
  const panel = useId();
  const first = accounts.filter(firstSyncing);
  const older = first.length ? [] : accounts.filter(backfilling);
  const syncing = first.length ? first : older;
  if (!syncing.length) return null;
  const detail = syncing.length === 1 ? t("firstSync.detail", { window: windowLabel(syncing[0]!.syncWindowDays ?? general) }) : t("firstSync.accounts", { count: syncing.length });
  // every account still syncing, first syncs and backfills both
  const rows = accounts.filter((a) => firstSyncing(a) || backfilling(a));
  return (
    <div className="flex shrink-0 px-2 pt-1" data-testid="first-sync-pill">
      <div className="group min-w-0 flex-1 rounded-lg border border-sidebar-border text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="first-sync-toggle"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          <div className="min-w-0 flex-1 leading-tight">
            <p role="status" className="truncate font-medium text-sidebar-foreground">
              {first.length ? t("firstSync.title") : t("firstSync.older")}
            </p>
            <p className="truncate text-muted-foreground" data-testid="first-sync-detail">
              {detail}
            </p>
          </div>
          {/* on hover (or open, or reached with Tab): the card opens */}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-fast ease-motion group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
              open && "rotate-180 opacity-100",
            )}
          />
        </button>
        <div
          id={panel}
          data-shown={open || undefined}
          inert={!open}
          className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-base ease-motion data-shown:grid-rows-[1fr] data-shown:opacity-100"
        >
          <div className="min-h-0 overflow-hidden">
            <ul className="space-y-2.5 px-2.5 pt-0.5 pb-2.5" data-testid="first-sync-progress">
              {rows.map((a) => {
                const stopsAt = firstSyncing(a) ? Date.now() - (a.syncWindowDays ?? general) * DAY : (a.backfillSince ?? Date.now());
                const { label, short, fraction } = syncLeft(a.syncState.progress, stopsAt);
                return (
                  <li key={a.id} data-testid={`first-sync-account-${a.id}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-sidebar-foreground">{a.displayName}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums" aria-hidden>
                        {short}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={a.displayName}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
                      aria-valuetext={label}
                      className="relative mt-1 h-[3px] overflow-hidden rounded-full bg-sidebar-border"
                    >
                      <div
                        className="h-full rounded-full bg-primary/80 transition-[width] duration-base ease-motion"
                        style={{ width: `${fraction === null ? 30 : Math.max(4, fraction * 100)}%` }}
                      />
                      <div aria-hidden className="sync-sheen absolute inset-y-0 left-0 w-2/5" />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
