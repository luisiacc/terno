import { t } from "@terno/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { setApp, useApp } from "~/state/app";
import { RemindPicker } from "./remind-picker";

/** Plan 87: the picker where no reader holds it (the menu's "Pick date & time…", h on the list). */
export function RemindDialog() {
  const target = useApp((s) => s.remindTarget);
  const close = () => setApp({ dialog: null, remindTarget: null });
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xs" data-testid="remind-dialog">
        <DialogHeader>
          <DialogTitle>{t("remind.title")}</DialogTitle>
        </DialogHeader>
        {target && <RemindPicker threadIds={target.ids} initialKind={target.kind} custom={target.custom} done={close} />}
      </DialogContent>
    </Dialog>
  );
}
