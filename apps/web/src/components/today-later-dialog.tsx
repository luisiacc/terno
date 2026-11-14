import { defaultRemindAt } from "@terno/core";
import { t } from "@terno/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { actOnTask, type TodayTask } from "~/lib/dated";
import { setApp } from "~/state/app";
import { useToday } from "~/state/today";
import { WhenForm } from "./when-fields";

const HOUR = 3_600_000;

/** Where its own moment starts: the reminder picker's (tomorrow at 9), or, on a Plan that ends before then, an hour before its end. */
export function laterStart(task: TodayTask, now = Date.now()): number {
  const start = defaultRemindAt(new Date(now));
  if (task.kind !== "dated" || task.end === null || start < task.end) return start;
  const minute = 60_000;
  return Math.ceil(Math.max(now + 15 * minute, task.end - HOUR) / minute) * minute;
}

/** Plan 204 (after the panel, fix 10): a Today row's Later at a moment of your own, the reminder's date and time (plan 87); on a Plan, before it ends. */
export function openTodayLater(task: TodayTask): void {
  useToday.setState({ laterPick: task });
  setApp({ dialog: "todayLater" });
}

export function TodayLaterDialog() {
  const task = useToday((s) => s.laterPick);
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
        {task && (
          <WhenForm
            start={laterStart(task)}
            before={task.kind === "dated" ? task.end : null}
            testPrefix="today-later"
            submit={t("dated.laterSet")}
            onSet={(at) => {
              close();
              void actOnTask(task, "later", at);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
