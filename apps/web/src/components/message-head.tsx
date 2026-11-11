import type { Address } from "@terno/core";
import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import type { ReactNode } from "react";
import { SenderAvatar } from "./sender-avatar";

/** Who a message went to: To, then Cc, on one quiet line. */
export function Recipients({ m, className }: { m: { to: readonly Address[]; cc: readonly Address[] }; className?: string }) {
  const people = (list: readonly Address[]) => list.map((a) => a.name || a.email).join(", ");
  return (
    <span data-testid="recipients" className={cn("block truncate text-xs text-muted-foreground", className)}>
      {t("reader.to")} {people(m.to)}
      {m.cc.length > 0 && ` · ${t("reader.cc")} ${people(m.cc)}`}
    </span>
  );
}

/**
 * An open message's header: the avatar, who wrote it (the address beside a name), to whom. One family for a message and
 * for one still in its Undo window (plan 182): `trailing` is the date (and the chevron), or the window's status.
 */
export function OpenHead({ from, to, cc, icon, person, trailing, recipientsClass }: { from: Address; to: readonly Address[]; cc: readonly Address[]; icon: boolean; person: boolean; trailing: ReactNode; recipientsClass?: string }) {
  const name = from.name || from.email;
  return (
    <>
      <SenderAvatar name={name} email={from.email} icon={icon} person={person} className="mt-px size-(--avatar-message) text-2xs" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="type-sender-name min-w-0 truncate">{name}</span>
          {from.name && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{from.email}</span>}
          {trailing}
        </span>
        <Recipients m={{ to, cc }} className={cn("mt-px", recipientsClass ?? "pr-8")} />
      </span>
    </>
  );
}
