import { t } from "@terno/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { laterNote, laterStart, laterWindow, type LaterWindow } from "~/lib/dated";
import { laterFromPicker } from "~/lib/today-task";
import { setApp } from "~/state/app";
import { useToday } from "~/state/today";
import { WhenForm } from "./when-fields";

/**
 * Plan 204 (after the panel, fix 10): a Today row's Later at a moment of your own, the reminder's date and time (plan 87),
 * in Later's window (the third panel round: before a timed item's moment, a Plan's end; a promise of yours, any moment).
 * Opened by `openTodayLater`.
 */
export function TodayLaterDialog() {
  const pick = useToday((s) => s.laterPick);
  const task = pick?.task ?? null;
  const close = () => {
    useToday.setState({ laterPick: null });
    setApp({ dialog: null });
  };
  return <LaterDialog span={task && laterWindow(task)} testId="today-later-dialog" testPrefix="today-later" close={close} onSet={(at) => pick && laterFromPicker(pick, at)} />;
}

/** Later at a moment of your own, in its window: What matters' picker, People's too (plan 281, owner after the QA panel). */
export function LaterDialog({ span, testId, testPrefix, close, onSet }: { span: LaterWindow | null; testId: string; testPrefix: string; close: () => void; onSet: (at: number) => void }) {
  return (
    <Dialog open={span !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xs" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{t("dated.later")}</DialogTitle>
        </DialogHeader>
        {span && (
          <WhenForm
            start={laterStart(span)}
            before={span.before}
            notes={laterNote(span)}
            testPrefix={testPrefix}
            submit={t("dated.laterSet")}
            onSet={(at) => {
              close();
              onSet(at);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
