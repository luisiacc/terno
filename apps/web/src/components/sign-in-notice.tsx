import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { KeyRound, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { clearAttemptError, noticeAccounts, prepareGoogle, putOff, sendOnly, useSignIn } from "~/lib/sign-in";
import { useApp } from "~/state/app";

const WEB = import.meta.env.VITE_TARGET === "web";
type PanelProps = Parameters<typeof import("./sign-in-panel").default>[0];
/** the panel once its chunk is in: rendered at once, so the popover's first focus lands in it (lazy suspends a first time even preloaded) */
let Loaded: ((props: PanelProps) => React.ReactNode) | null = null;
const loadPanel = () =>
  import("./sign-in-panel").then((m) => {
    Loaded = m.default;
    return m;
  });
const Lazy = lazy(loadPanel);
function SignInPanel(props: PanelProps) {
  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
}

/** the panel's chunk (and, on the web, Google's script) before the click: an account needs it now */
function usePrepare(accounts: readonly Account[]): void {
  const gmail = accounts.some((a) => a.kind === "gmail");
  useEffect(() => {
    void loadPanel().catch(() => {});
    if (WEB && gmail) prepareGoogle();
  }, [gmail]);
}

/** Closing the panel drops errors left in it (the next look starts clean); an attempt in flight keeps going. */
function closed(accounts: readonly Account[]): void {
  for (const a of accounts) clearAttemptError(a.id);
}

/** the request (a parked send's "Sign in") this window already opened */
let handled = 0;

/**
 * Plan 25: one calm line at the foot of the sidebar while an account needs you to sign in again
 * ("Personal needs you to sign in" over "New mail waits until you do"), in the connection pill's
 * family. The line opens the sign-in panel above it; "Later" puts it off until that account needs a
 * sign-in anew (its row keeps its key). A screen reader hears it once, when the set changes.
 */
export function SignInNotice() {
  const accounts = useApp((s) => s.accounts);
  const later = useSignIn((s) => s.later);
  const shown = noticeAccounts(accounts, later);
  if (!shown.length) return null;
  return <Notice accounts={shown} />;
}

function Notice({ accounts }: { accounts: Account[] }) {
  const [open, setOpen] = useState(false);
  const request = useSignIn((s) => s.request);
  usePrepare(accounts);
  useEffect(() => {
    if (!request || request.seq <= handled) return;
    handled = request.seq;
    setOpen(true);
  }, [request]);
  const one = accounts.length === 1 ? accounts[0]! : null;
  const title = one ? t("signIn.notice.one", { name: one.displayName }) : t("signIn.notice.many", { count: accounts.length });
  const waits = accounts.every(sendOnly) ? t("signIn.notice.sendWaits") : t("signIn.notice.waits");
  const later = () => {
    setOpen(false);
    putOff(accounts.map((a) => a.id));
  };
  return (
    <div className="flex shrink-0 px-2 pt-1" data-testid="sign-in-notice" data-count={accounts.length} data-sign-in-ui>
      {/* said once, when it changes (the backend's account events leave it as it is) */}
      <p role="status" className="sr-only">
        {title}
      </p>
      <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-sidebar-border py-1 pr-1 pl-1 text-xs">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) closed(accounts);
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                data-testid="sign-in-open"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pr-1 pl-1.5 text-left outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              />
            }
          >
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 leading-snug">
              <span className="block font-medium text-balance break-words text-sidebar-foreground" data-testid="sign-in-title">
                {title}
              </span>
              <span className="block text-balance break-words text-muted-foreground">{waits}</span>
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={6} className="max-h-(--available-height) w-80 max-w-(--available-width) gap-3 overflow-y-auto" data-testid="sign-in-popover" data-sign-in-ui>
            <SignInPanel accounts={accounts} onLater={later} />
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("signIn.later")}
                data-testid="sign-in-dismiss"
                onClick={later}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              />
            }
          >
            <X className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{t("signIn.later")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Plan 25: the key at the end of an account's sidebar row while it needs a sign-in. Quiet (the muted
 * ink, no fill); its name and tooltip say why; it opens that account's sign-in beside the row.
 */
export function SignInMarker({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const label = t("signIn.marker", { email: account.email });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) closed([account]);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              onPointerEnter={() => void loadPanel().catch(() => {})}
              onFocus={() => {
                void loadPanel().catch(() => {});
                if (WEB && account.kind === "gmail") prepareGoogle();
              }}
              render={
                <button
                  type="button"
                  aria-label={label}
                  data-testid={`sign-in-marker-${account.id}`}
                  data-sign-in-ui
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-foreground"
                />
              }
            />
          }
        >
          <KeyRound className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" sideOffset={8} className="max-h-(--available-height) w-80 max-w-(--available-width) gap-3 overflow-y-auto" data-testid="sign-in-popover" data-sign-in-ui>
        <SignInPanel
          accounts={[account]}
          onLater={() => {
            setOpen(false);
            putOff([account.id]);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
