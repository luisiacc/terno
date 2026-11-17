import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { cn } from "@terno/ui/lib/utils";
import { useId, useRef, useState } from "react";
import { changeItem, changeSaid, changeStart, changeTo, closeChange, useChangePick, type ChangeTarget, type ChangeTo } from "~/lib/change";
import { midnight, useWhen, WhenFields } from "./when-fields";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): an item's new day, and its time when it has one, in the shared date and
 * time fields (plan 87's, Later's own), with no window but now: the day can be any ahead, a time any after now. "At a time"
 * says whether it has one (a bill is due on a day; an appointment at a time). The clock is read again on submit.
 */
export function ChangeForm({ target, onSet, testPrefix, className }: { target: Pick<ChangeTarget, "dueDay" | "dueAt" | "timed">; onSet: (to: ChangeTo) => void; testPrefix: string; className?: string }) {
  const [start] = useState(() => changeStart(target));
  const when = useWhen(start.at);
  const [timed, setTimed] = useState(start.timed);
  const [, recheck] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const noteId = useId();
  const ready = timed ? when.ready : true;
  // a day alone may be today; a time must be ahead
  const past = timed ? when.past : when.day.getTime() < midnight(new Date()).getTime();
  return (
    <form
      ref={formRef}
      className={cn("flex flex-col gap-2", className)}
      data-testid={`${testPrefix}-form`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || past) return;
        if (timed && when.chosen <= Date.now()) return recheck((n) => n + 1);
        onSet(changeTo(timed ? when.chosen : when.day.getTime(), timed));
      }}
    >
      <WhenFields when={{ ...when, past }} testPrefix={testPrefix} describedBy={noteId} noTime={!timed} onEnter={() => formRef.current?.requestSubmit()} />
      <label className="flex w-fit items-center gap-2 text-sm" data-testid={`${testPrefix}-timed`}>
        <Checkbox checked={timed} onCheckedChange={(on) => setTimed(on)} data-testid={`${testPrefix}-timed-box`} />
        {t("dated.changeTimed")}
      </label>
      {past && (
        <p id={noteId} className="text-xs text-destructive-ink" data-testid={`${testPrefix}-past`}>
          {t("remind.past")}
        </p>
      )}
      <Button type="submit" size="sm" data-testid={`${testPrefix}-set`} disabled={past || !ready} className="self-end">
        {t("dated.changeSet")}
      </Button>
    </form>
  );
}

/** The form from the row's menu and the palette, for the item as it was when it opened (`openChange`). */
export function TodayChangeDialog() {
  const target = useChangePick((s) => s.target);
  // the claims ledger's second batch: a promise as its row says it, "You said you'd…"; a sentence that long gets a third line
  const said = target && changeSaid(target);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && closeChange()}>
      <DialogContent className="sm:max-w-xs" data-testid="today-change-dialog">
        <DialogHeader>
          <DialogTitle>{t("dated.changeTitle")}</DialogTitle>
          {said && <DialogDescription className="line-clamp-3" title={said} data-testid="today-change-text">{said}</DialogDescription>}
        </DialogHeader>
        {target && (
          <ChangeForm
            target={target}
            testPrefix="today-change"
            onSet={(to) => {
              closeChange();
              void changeItem(target, to);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
