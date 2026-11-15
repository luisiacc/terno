import { t } from "@terno/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { laterNote, laterStart, laterWindow, type TodayTask } from "~/lib/dated";
import { actOnTodayRow } from "~/lib/today-task";
import { setApp } from "~/state/app";
import { useToday } from "~/state/today";
import { WhenForm } from "./when-fields";

/**
 * Plan 204 (after the panel, fix 10): a Today row's Later at a moment of your own, the reminder's date and time (plan 87),
 * in Later's window (the third panel round: before a timed item's moment, a Plan's end; a promise of yours, any moment).
 */
export function openTodayLater(threadId: number, task: TodayTask): void {
  useToday.setState({ laterPick: { threadId, task } });
  setApp({ dialog: "todayLater" });
}

export function TodayLaterDialog() {
  const pick = useToday((s) => s.laterPick);
  const task = pick?.task ?? null;
  const span = task && laterWindow(task);
  const close = () => {
    useToday.setState({ laterPick: null });
    setApp({ dialog: null });
  };
  return (
    <Dialog open={task !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xs" data-testid="today-later-dialog">
        <DialogHeader>
          <DialogTitle>{t("dated.later")}</DialogTitle>
        </DialogHeader>
        {task && span && (
          <WhenForm
            start={laterStart(span)}
            before={span.before}
            notes={laterNote(span)}
            testPrefix="today-later"
            submit={t("dated.laterSet")}
            onSet={(at) => {
              close();
              if (pick) void actOnTodayRow(pick.threadId, task, "later", at);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
