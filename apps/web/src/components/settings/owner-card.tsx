import type { Account } from "@terno/core";
import type { OwnerIdentity } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { BadgeCheck, Loader2, UserRound } from "lucide-react";
import { localeTag, t } from "@terno/i18n";
import { useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { SettingsGroup } from "./parts";
import { setApp } from "~/state/app";

// Spanish short months carry a period ("oct.") that Terno never shows
const verifiedDate = (ms: number) => new Intl.DateTimeFormat(localeTag(), { day: "numeric", month: "short", year: "numeric" }).format(ms).replace(".", "");

function verifiedLine(owner: OwnerIdentity): string {
  if (owner.migrated) return t("account.owner.migrated");
  const google = owner.verifiedBy === "google_oauth";
  if (!owner.verifiedAt) return google ? t("account.owner.verifiedGoogle") : t("account.owner.verifiedImap");
  const date = verifiedDate(owner.verifiedAt);
  return google ? t("account.owner.verifiedGoogleOn", { date }) : t("account.owner.verifiedImapOn", { date });
}

/** Re-verifies another connected mailbox right now and makes it the Terno account. */
function ChangeOwner({ owner, accounts, onDone }: { owner: OwnerIdentity; accounts: Account[]; onDone: () => void }) {
  const candidates = accounts.filter((a) => a.id !== owner.accountId);
  const [accountId, setAccountId] = useState<number | null>(candidates[0]?.id ?? null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const target = candidates.find((a) => a.id === accountId);
  if (candidates.length === 0) return <p className="py-3 text-xs text-muted-foreground">{t("account.owner.noCandidates")}</p>;

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const next = await client.call("identity.changeOwner", { accountId: target.id, password: target.kind === "imap" ? password : undefined });
      setApp({ owner: next });
      snack.success(t("account.owner.changed", { email: next.email }));
      onDone();
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2 py-3"
      data-testid="change-owner"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-xs text-muted-foreground">{t("account.owner.changeHint")}</p>
      <div className="flex gap-2">
        <Select
          disabled={busy}
          value={accountId === null ? null : String(accountId)}
          onValueChange={(v) => {
            // a password belongs to one mailbox: never send it to another server
            setPassword("");
            setAccountId(Number(v));
          }}
          items={candidates.map((a) => ({ value: String(a.id), label: a.email }))}>
          <SelectTrigger size="sm" className="min-w-0 flex-1" data-testid="change-owner-account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {target?.kind === "imap" && (
          <Input type="password" required autoComplete="off" disabled={busy} className="h-7 w-44 bg-background dark:bg-input/30" placeholder={t("account.password")} aria-label={t("account.owner.password")} data-testid="change-owner-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !target || (target.kind === "imap" && !password)} data-testid="change-owner-submit">
          {busy && <Loader2 className="animate-spin" />} {target?.kind === "gmail" ? t("account.owner.verifyGoogle") : t("account.owner.verifyChange")}
        </Button>
      </div>
    </form>
  );
}

export function OwnerCard({ owner, demo, accounts }: { owner: OwnerIdentity | null; demo: boolean; accounts: Account[] }) {
  const [changing, setChanging] = useState(false);
  if (demo || !owner) {
    return (
      <SettingsGroup title={t("account.owner.title")} testId="owner-card">
        <div className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
          <UserRound className="size-4 shrink-0" /> {demo ? t("account.owner.demo") : t("account.owner.none")}
        </div>
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup title={t("account.owner.title")} testId="owner-card" footer={t("account.owner.footer")}>
      <div className="flex items-center gap-3 py-2.5">
        <BadgeCheck className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="owner-email">
            {owner.email}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {verifiedLine(owner)}
            {owner.accountId === null && ` · ${t("account.owner.disconnected")}`}
          </p>
        </div>
        {!changing && (
          <Button variant="outline" size="sm" data-testid="change-owner-open" onClick={() => setChanging(true)}>
            {t("account.owner.change")}
          </Button>
        )}
      </div>
      {changing && <ChangeOwner owner={owner} accounts={accounts} onDone={() => setChanging(false)} />}
    </SettingsGroup>
  );
}
