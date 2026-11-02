import { formatAddressList, isValidEmail, parseAddressList, type Category } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { useId, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { RecipientInput } from "./recipient-input";

/** a text field's frame (the Input's own) around the recipient field, its ring while you type in it */
const FIELD = "flex min-w-0 items-start gap-2 rounded-lg border border-input px-2.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring dark:bg-input/30";
const INPUT = "h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground";

/**
 * Plan 116: where a category's new mail is forwarded. Opened from its
 * right-click menu; lazy (out of the entry chunk). Saving turns it on (again,
 * after a Stop at the cap); "Stop forwarding" forgets the addresses.
 */
export function CategoryForwardDialog({ category, open, onOpenChange }: { category: Category; open: boolean; onOpenChange: (open: boolean) => void }) {
  const accountId = useApp((s) => s.accounts[0]?.id ?? 0);
  const [value, setValue] = useState(() => formatAddressList(category.forward?.addresses ?? []));
  const [busy, setBusy] = useState(false);
  const id = useId();
  const parsed = parseAddressList(value);
  const invalid = parsed.find((a) => !isValidEmail(a.email));
  const addresses = parsed.filter((a) => isValidEmail(a.email));

  const save = async (forward: { addresses: { name: string; email: string }[]; enabled: boolean } | null) => {
    setBusy(true);
    try {
      await client.call("categories.setForward", { categoryId: category.id, forward });
    } catch (error) {
      snack.error(t("category.forward.failed", { category: category.name }), { description: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      setBusy(false);
    }
    onOpenChange(false);
    snack.success(t(forward ? "category.forward.saved" : "category.forward.stopped", { category: category.name }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="category-forward-dialog">
        <DialogHeader>
          <DialogTitle>{t("category.forward.title", { name: category.name })}</DialogTitle>
          <DialogDescription>{t("category.forward.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {/* one field, as the composer's To row reads: its name inline, the chips and the caret inside one border */}
          <div className={FIELD}>
            <label htmlFor={id} className="flex h-9 shrink-0 items-center text-sm text-muted-foreground">{t("category.forward.to")}</label>
            <RecipientInput
              id={id}
              testId="category-forward-to"
              label={t("category.forward.to")}
              value={value}
              onChange={(v) => void setValue(v)}
              accountId={accountId}
              others={[]}
              className={INPUT}
            />
          </div>
          {invalid && <p role="alert" className="text-xs text-destructive-ink">{t("category.forward.invalid", { address: invalid.email })}</p>}
          {category.forward && !category.forward.enabled && <p className="text-xs text-muted-foreground">{t("category.forward.paused")}</p>}
        </div>
        <DialogFooter>
          {category.forward && (
            <Button variant="ghost" className="mr-auto" disabled={busy} data-testid="category-forward-stop" onClick={() => void save(null)}>
              {t("category.forward.stop")}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !addresses.length || Boolean(invalid)} data-testid="category-forward-save" onClick={() => void save({ addresses, enabled: true })}>
            {t("category.forward.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
