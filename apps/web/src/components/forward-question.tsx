import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Forward } from "@terno/ui/icons";
import { useState } from "react";
import { answerForwards, useForwards } from "~/lib/forwards";

/**
 * Plan 116's cap: a rule that forwarded 100 messages in a day holds the next
 * ones until the user says to keep going or to stop. It stays at the top of
 * the list (in every view: forwarding isn't the Inbox's alone) until answered.
 */
export function ForwardQuestion() {
  const question = useForwards((s) => s.questions[0]);
  const [busy, setBusy] = useState(false);
  if (!question) return null;
  const answer = async (keep: boolean) => {
    setBusy(true);
    try {
      await answerForwards(question.rule, keep);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-labelledby="forward-question-text" data-testid="forward-question" className="mx-3 mt-1 mb-1 flex items-start gap-2.5 rounded-[calc(var(--radius-lg)+2px)] bg-tint p-2.5 text-xs">
      <Forward className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p id="forward-question-text" className="text-foreground">{t("forward.question", { rule: question.ruleName, count: question.count })}</p>
        <p className="mt-0.5 text-muted-foreground">{t("forward.questionHeld", { count: question.held })}</p>
        <div className="mt-1.5 flex gap-1.5">
          <Button size="xs" variant="outline" disabled={busy} data-testid="forward-question-keep" onClick={() => void answer(true)}>
            {t("forward.keep")}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} data-testid="forward-question-stop" onClick={() => void answer(false)}>
            {t("forward.stop")}
          </Button>
        </div>
      </div>
    </div>
  );
}
