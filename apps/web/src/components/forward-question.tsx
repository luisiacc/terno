import { t } from "@terno/i18n";
import { Announcement } from "@terno/ui/components/announcement";
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
    // no close: it stays until answered
    <Announcement
      role="group"
      data-testid="forward-question"
      icon={<Forward />}
      title={t("forward.question", { rule: question.ruleName, count: question.count })}
      description={t("forward.questionHeld", { count: question.held })}
      actions={
        <>
          <Button size="xs" variant="outline" disabled={busy} data-testid="forward-question-keep" onClick={() => void answer(true)}>
            {t("forward.keep")}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} data-testid="forward-question-stop" onClick={() => void answer(false)}>
            {t("forward.stop")}
          </Button>
        </>
      }
    />
  );
}
