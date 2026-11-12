import { signInMethod, unhandled, type Account } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { AccountRing } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { PopoverDescription, PopoverTitle } from "@terno/ui/components/popover";
import { cn } from "@terno/ui/lib/utils";
import { Spinner } from "@terno/ui/components/spinner";
import { createContext, useContext, useEffect, useId, useRef, useState, type RefObject } from "react";
import { canStart, clearAttemptError, needsGoogleScript, prepareGoogle, sendOnly, signInAgain, useSignIn, type Attempt } from "~/lib/sign-in";

const WEB = import.meta.env.VITE_TARGET === "web";

/** the sidebar's account row: where focus goes when the panel it was in goes away */
const sidebarRow = (accountId: number) => document.querySelector<HTMLElement>(`[data-testid="nav-account-${accountId}"]`);

/** where this panel is (its next action is looked for only inside it) and where focus goes after it (Codex review of plan 184, #5) */
const Scope = createContext<{ root: RefObject<HTMLDivElement | null>; home(accountId: number): HTMLElement | null }>({ root: { current: null }, home: sidebarRow });

/**
 * Plan 25: the sign-in panel. One account: its
 * name, a line saying nothing is lost, and its one action. Several: one hairline section each.
 * Errors are inline, under the account they belong to; "Later" closes it.
 */
export default function SignInPanel({ accounts, onLater, home = sidebarRow }: { accounts: Account[]; onLater: () => void; home?: (accountId: number) => HTMLElement | null }) {
  const one = accounts.length === 1 ? accounts[0]! : null;
  const webGmail = accounts.some(needsGoogleScript);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (webGmail) prepareGoogle();
  }, [webGmail]);
  return (
    <Scope.Provider value={{ root, home }}>
    <div ref={root} className="flex flex-col gap-3" data-sign-in-ui data-testid="sign-in-panel">
      <div className="flex flex-col gap-1">
        {one ? (
          <div className="flex min-w-0 items-center gap-2">
            <AccountRing color={one.color} />
            <div className="min-w-0">
              <PopoverTitle className="truncate text-sm">{t("signIn.title.one", { name: one.displayName })}</PopoverTitle>
              <p className="truncate text-xs text-muted-foreground">{one.email}</p>
            </div>
          </div>
        ) : (
          <PopoverTitle className="text-sm">{t("signIn.notice.many", { count: accounts.length })}</PopoverTitle>
        )}
        <PopoverDescription className="text-xs leading-relaxed">{one && sendOnly(one) ? t("signIn.reassureSend") : t("signIn.reassure")}</PopoverDescription>
        {webGmail && <p className="text-xs leading-relaxed text-muted-foreground">{t("signIn.webGmail")}</p>}
      </div>
      {/* one list, keyed by account, however many there are: another account failing or coming back while you
          type a password never remounts (and empties) your field (Codex code review #3) */}
      <ul className={cn("flex flex-col", !one && "hairline-divide hairline-t")}>
        {accounts.map((a) => (
          <li key={a.id} className={cn("flex flex-col gap-2", !one && "py-2.5")} data-testid="sign-in-section" data-account-id={a.id}>
            <AccountSignIn account={a} expanded={Boolean(one)} />
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onLater} data-testid="sign-in-later">
          {t("signIn.later")}
        </Button>
      </div>
    </div>
    </Scope.Provider>
  );
}

/**
 * Focus was on what just went away (this panel, its section, the notice it was in): the next account's action in
 * this panel, else where the panel came from (the account's row). Focus that fell to the popup around this panel
 * (Base UI's restore when a focused section goes) counts as fallen. Focus anywhere else stays, another sign-in panel
 * included (a password typed there while this account's Google page finished: plan 184's code review #3).
 */
function settleFocus(accountId: number, scope: React.ContextType<typeof Scope>): void {
  const active = document.activeElement;
  const panel = scope.root.current?.isConnected ? scope.root.current : null;
  const fell = !active || active === document.body || (panel !== null && (panel.contains(active) || active.contains(panel)));
  if (!fell) return;
  const next = panel?.querySelector<HTMLElement>(`[data-sign-in-action]:not([data-account-id="${accountId}"])`);
  (next ?? scope.home(accountId))?.focus();
}

function useRun(): (account: Account, password?: string) => Promise<boolean> {
  const scope = useContext(Scope);
  return async (account, password) => {
    const ok = await signInAgain(account, password);
    // after the account's event has redrawn the panel (its section gone, or the one left laid out alone)
    if (ok) requestAnimationFrame(() => settleFocus(account.id, scope));
    return ok;
  };
}

function AccountSignIn({ account, expanded = false }: { account: Account; expanded?: boolean }) {
  const attempt = useSignIn((s) => s.attempts.get(account.id) ?? null);
  const google = useSignIn((s) => s.google);
  const [asking, setAsking] = useState(expanded);
  // alone in the panel its field is just there; among several it waits for "Enter password". Once shown it stays
  // (latched as it renders: another account failing later never takes a half-typed password away, review 2)
  if (expanded && !asking) setAsking(true);
  const form = signInMethod(account.kind) === "password" && asking;
  return (
    <>
      {!expanded && (
        <div className="flex min-w-0 items-center gap-2">
          <AccountRing color={account.color} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{account.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{account.email}</p>
          </div>
          {!form && <Action account={account} attempt={attempt} google={google} onAsk={() => setAsking(true)} />}
        </div>
      )}
      {form ? (
        <PasswordForm account={account} attempt={attempt} autoFocus={!expanded} />
      ) : (
        expanded && <Action account={account} attempt={attempt} google={google} onAsk={() => setAsking(true)} />
      )}
      <AttemptError attempt={attempt} />
      {/* the web's Google script didn't load (offline?): say so; the button tries again (Codex code review #4) */}
      {needsGoogleScript(account) && google === "failed" && (
        <p role="alert" className="text-xs leading-relaxed text-destructive-ink" data-testid="sign-in-google-failed">
          {t("web.google.loadFailed")}
        </p>
      )}
    </>
  );
}

function Action({ account, attempt, google, onAsk }: { account: Account; attempt: Attempt | null; google: ReturnType<typeof useSignIn.getState>["google"]; onAsk: () => void }) {
  const common = { "data-sign-in-action": true, "data-account-id": account.id } as const;
  const run = useRun();
  const method = signInMethod(account.kind);
  switch (method) {
  case "password":
    return (
      <Button size="sm" variant="outline" onClick={onAsk} data-testid="sign-in-password-reveal" {...common}>
        {t("signIn.password.reveal")}
      </Button>
    );
  case "google":
    break;
  default: unhandled(method);
  }
  // the desktop's Google page is open in the browser: say where the user is expected, and offer it again
  if (attempt?.busy && !WEB) {
    return (
      <div className="flex items-center gap-2">
        <p aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sign-in-waiting">
          <Spinner className="size-3.5 text-current" aria-hidden />
          {t("signIn.google.waiting")}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void run(account)} data-testid="sign-in-google-again" {...common}>
          {t("signIn.google.again")}
        </Button>
      </div>
    );
  }
  const ready = canStart(account, google);
  const failed = google === "failed";
  const busy = Boolean(attempt?.busy);
  return (
    <Button
      size="sm"
      aria-disabled={(!ready && !failed) || busy || undefined}
      onClick={() => {
        if (!ready && failed) prepareGoogle();
        else if (ready && !busy) void run(account);
      }}
      data-testid="sign-in-google"
      {...common}
    >
      {(busy || google === "loading") && <Spinner aria-hidden />}
      {ready || google !== "loading" ? t("signIn.google") : t("signIn.google.loading")}
    </Button>
  );
}

function PasswordForm({ account, attempt, autoFocus }: { account: Account; attempt: Attempt | null; autoFocus: boolean }) {
  const [password, setPassword] = useState("");
  const id = useId();
  const run = useRun();
  const busy = Boolean(attempt?.busy);
  return (
    <form
      className="flex items-center gap-2"
      data-testid="sign-in-password-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (password && !busy) void run(account, password).then((ok) => ok && setPassword(""));
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t("account.passwordFor", { email: account.email })}
      </label>
      <Input
        id={id}
        type="password"
        autoComplete="current-password"
        autoFocus={autoFocus}
        required
        // what's being checked can't change under it (Settings' rule, Codex review of plan 184 #6)
        readOnly={busy}
        className="h-8 flex-1"
        placeholder={t("account.password")}
        value={password}
        aria-invalid={attempt?.error ? true : undefined}
        onChange={(e) => {
          setPassword(e.target.value);
          clearAttemptError(account.id);
        }}
        data-sign-in-action
        data-account-id={account.id}
        data-testid="sign-in-password"
      />
      <Button type="submit" size="sm" loading={busy} aria-disabled={busy || !password || undefined} data-testid="sign-in-submit">
        {t("signIn.submit")}
      </Button>
    </form>
  );
}

function AttemptError({ attempt }: { attempt: Attempt | null }) {
  if (!attempt?.error) return null;
  return (
    <div role="alert" className="flex flex-col gap-0.5 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="sign-in-error">
      <p className="text-destructive-ink">{attempt.error.message}</p>
      {attempt.error.detail && <p className="text-muted-foreground">{attempt.error.detail}</p>}
    </div>
  );
}
