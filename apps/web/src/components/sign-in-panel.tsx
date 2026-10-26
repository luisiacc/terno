import type { Account, CategoryColor } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { PopoverDescription, PopoverTitle } from "@terno/ui/components/popover";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { canStart, clearAttemptError, prepareGoogle, sendOnly, signInAgain, useSignIn, type Attempt } from "~/lib/sign-in";

const WEB = import.meta.env.VITE_TARGET === "web";

/**
 * Plan 25: the sign-in panel (lazy: only an account that needs it loads it). One account: its
 * name, a line saying nothing is lost, and its one action. Several: one hairline section each.
 * Errors are inline, under the account they belong to; "Later" closes it.
 */
export default function SignInPanel({ accounts, onLater }: { accounts: Account[]; onLater: () => void }) {
  const one = accounts.length === 1 ? accounts[0]! : null;
  const webGmail = WEB && accounts.some((a) => a.kind === "gmail");
  useEffect(() => {
    if (webGmail) prepareGoogle();
  }, [webGmail]);
  return (
    <div className="flex flex-col gap-3" data-sign-in-ui data-testid="sign-in-panel">
      <div className="flex flex-col gap-1">
        {one ? (
          <div className="flex min-w-0 items-center gap-2">
            <CategoryDot color={one.color as CategoryColor} />
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
      {one ? (
        <AccountSignIn account={one} expanded />
      ) : (
        <ul className="hairline-divide hairline-t flex flex-col">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-2.5" data-testid="sign-in-section" data-account-id={a.id}>
              <AccountSignIn account={a} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onLater} data-testid="sign-in-later">
          {t("signIn.later")}
        </Button>
      </div>
    </div>
  );
}

/** Focus was on what just went away (the panel, its section, the notice): the next account's action, else the account's row. */
function settleFocus(accountId: number): void {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest("[data-sign-in-ui]")) return;
  const next = document.querySelector<HTMLElement>(`[data-sign-in-ui] [data-sign-in-action]:not([data-account-id="${accountId}"])`);
  (next ?? document.querySelector<HTMLElement>(`[data-testid="nav-account-${accountId}"]`))?.focus();
}

async function run(account: Account, password?: string): Promise<boolean> {
  const ok = await signInAgain(account, password);
  // after the account's event has redrawn the panel (its section gone, or the one left laid out alone)
  if (ok) requestAnimationFrame(() => settleFocus(account.id));
  return ok;
}

function AccountSignIn({ account, expanded = false }: { account: Account; expanded?: boolean }) {
  const attempt = useSignIn((s) => s.attempts.get(account.id) ?? null);
  const google = useSignIn((s) => s.google);
  const [asking, setAsking] = useState(expanded);
  return (
    <>
      {!expanded && (
        <div className="flex min-w-0 items-center gap-2">
          <CategoryDot color={account.color as CategoryColor} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{account.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{account.email}</p>
          </div>
          {!(account.kind === "imap" && asking) && (
            <Action account={account} attempt={attempt} google={google} onAsk={() => setAsking(true)} />
          )}
        </div>
      )}
      {account.kind === "imap" && asking ? (
        <PasswordForm account={account} attempt={attempt} autoFocus={!expanded} />
      ) : (
        expanded && <Action account={account} attempt={attempt} google={google} onAsk={() => setAsking(true)} />
      )}
      <AttemptError attempt={attempt} />
    </>
  );
}

function Action({ account, attempt, google, onAsk }: { account: Account; attempt: Attempt | null; google: ReturnType<typeof useSignIn.getState>["google"]; onAsk: () => void }) {
  const common = { "data-sign-in-action": true, "data-account-id": account.id } as const;
  if (account.kind === "imap") {
    return (
      <Button size="sm" variant="outline" onClick={onAsk} data-testid="sign-in-password-reveal" {...common}>
        {t("signIn.password.reveal")}
      </Button>
    );
  }
  // the desktop's Google page is open in the browser: say where the user is expected, and offer it again
  if (attempt?.busy && !WEB) {
    return (
      <div className="flex items-center gap-2">
        <p aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sign-in-waiting">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          {t("signIn.google.waiting")}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void run(account)} data-testid="sign-in-google-again" {...common}>
          {t("signIn.google.again")}
        </Button>
      </div>
    );
  }
  const ready = canStart(account, google);
  const busy = Boolean(attempt?.busy);
  return (
    <Button
      size="sm"
      aria-disabled={!ready || busy || undefined}
      onClick={() => {
        if (ready && !busy) void run(account);
      }}
      data-testid="sign-in-google"
      {...common}
    >
      {(busy || google === "loading") && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {ready || google !== "loading" ? t("signIn.google") : t("signIn.google.loading")}
    </Button>
  );
}

function PasswordForm({ account, attempt, autoFocus }: { account: Account; attempt: Attempt | null; autoFocus: boolean }) {
  const [password, setPassword] = useState("");
  const id = useId();
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
      <Button type="submit" size="sm" aria-disabled={busy || !password || undefined} data-testid="sign-in-submit">
        {busy && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
        {t("signIn.submit")}
      </Button>
    </form>
  );
}

function AttemptError({ attempt }: { attempt: Attempt | null }) {
  if (!attempt?.error) return null;
  return (
    <div role="alert" className="flex flex-col gap-0.5 text-xs leading-relaxed" data-testid="sign-in-error">
      <p className="text-destructive-ink">{attempt.error.message}</p>
      {attempt.error.detail && <p className="text-muted-foreground">{attempt.error.detail}</p>}
    </div>
  );
}
