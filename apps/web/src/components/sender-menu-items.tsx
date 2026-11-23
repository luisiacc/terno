import type { Category, CategoryColor } from "@terno/core";
import { t } from "@terno/i18n";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Eye, EyeOff, Filter, Tag } from "@terno/ui/icons";
import type { ComponentType, ReactNode } from "react";
import { whatMattersFor } from "~/lib/ai";
import { removeSenderFromCategory } from "~/lib/categorize";
import { showSender, stopShowing } from "~/lib/shown-senders";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { useIsShown } from "~/state/shown-senders";
import { applyScope } from "./category-snackbar";

/** A menu's own parts (the thread's right-click menu, a person's dropdown): the rows are the same in either. */
export interface MenuParts {
  Item: ComponentType<{ "data-testid"?: string; onClick?: () => void; children: ReactNode }>;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ "data-testid"?: string; children: ReactNode }>;
  SubContent: ComponentType<{ className?: string; "data-testid"?: string; children: ReactNode }>;
}

/**
 * What's done with everything from one sender (plans 63, 77, 89): file all their mail into a category, or out of one their
 * mail here is in, and a rule on their address. The thread menu's sender section and a person's menu (plan 180) both, so
 * the two never drift.
 */
export function SenderItems({ sender, accountId, categories, filedIn, parts }: { sender: { email: string; name: string }; /** plan 240: the account their mail is in, for What matters' own switch */ accountId?: number | null; categories: readonly Category[]; filedIn: readonly Category[]; parts: MenuParts }) {
  const { Item, Sub, SubTrigger, SubContent } = parts;
  const fileTo = categories.filter((c) => !filedIn.includes(c));
  const whatMatters = useApp((s) => whatMattersFor(s, accountId));
  return (
    <>
      {whatMatters && <ShowInWhatMatters sender={sender} Item={Item} />}
      {categories.length > 0 && (
        <Sub>
          <SubTrigger data-testid="menu-sender-file">
            <Tag />
            <span className="min-w-0 flex-1 truncate">{t("threadMenu.fileAll")}</span>
          </SubTrigger>
          <SubContent className="w-max max-w-96 min-w-60" data-testid="menu-sender-file-list">
            {fileTo.map((c) => (
              <Item key={c.id} data-testid={`menu-sender-file-${c.id}`} onClick={() => void applyScope(c.id, { kind: "sender", email: sender.email })}>
                <CategoryDot color={c.color as CategoryColor} className="mx-1" />
                <span className="truncate">{t("threadMenu.toCategory", { category: c.name })}</span>
              </Item>
            ))}
            {/* plan 77: the categories this mail is in offer the way out instead */}
            {filedIn.map((c) => (
              <Item key={c.id} data-testid={`menu-sender-out-${c.id}`} onClick={() => void removeSenderFromCategory(c.id, sender.email)}>
                <CategoryDot color={c.color as CategoryColor} className="mx-1" />
                <span className="truncate">{t("threadMenu.outOfCategory", { category: c.name })}</span>
              </Item>
            ))}
          </SubContent>
        </Sub>
      )}
      <Item
        data-testid="menu-filter"
        onClick={() => setApp({ dialog: "filters", filterPrefill: { name: t("threadMenu.filterName", { name: sender.name }), rule: { match: "all", conditions: [{ field: "from", op: "equals", value: sender.email }], actions: [{ type: "archive" }] } } })}
      >
        <Filter />
        <span className="min-w-0 flex-1 truncate">{t("threadMenu.createFilter")}</span>
      </Item>
    </>
  );
}

/** Plan 240: "Always show in What matters", or its Stop once they're shown (read from the senders kept for every menu). */
function ShowInWhatMatters({ sender, Item }: { sender: { email: string; name: string }; Item: MenuParts["Item"] }) {
  const shown = useIsShown(sender.email);
  return shown ? (
    <Item data-testid="menu-sender-unshow" onClick={() => void stopShowing(sender)}>
      <EyeOff />
      <span className="min-w-0 flex-1 truncate">{t("shown.menu.stop")}</span>
    </Item>
  ) : (
    <Item data-testid="menu-sender-show" onClick={() => void showSender(sender)}>
      <Eye />
      <span className="min-w-0 flex-1 truncate">{t("shown.menu.show")}</span>
    </Item>
  );
}

/** "Copy address", said once copied (or that it couldn't be). */
export function copyAddress(email: string): void {
  void navigator.clipboard.writeText(email).then(
    () => snack(t("threadMenu.copied", { email }), { duration: 2000 }),
    () => snack.error(t("threadMenu.copyFailed")),
  );
}
