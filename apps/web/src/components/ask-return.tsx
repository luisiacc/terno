import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { askOffered } from "~/lib/ai";
import { backToAnswer, useAsk } from "~/lib/ask";
import { useApp } from "~/state/app";

/** Plan 161: a conversation an Ask source opened says the way back to the answer, as the digest's does (plan 145). */
export function AskReturn({ threadId }: { threadId: number }) {
  const here = useAsk((s) => s.returnTo?.threadId === threadId);
  const offered = useApp(askOffered);
  if (!here || !offered) return null;
  return (
    // -ml-2: its words on the conversation's edge, its 24 px shape reaching past it
    <Button variant="ghost" size="xs" className="mb-2 -ml-2 gap-1.5 font-medium text-muted-foreground hover:text-foreground" data-testid="back-to-answer" onClick={backToAnswer}>
      {t("ask.backToAnswer")}
      <Shortcut keys="mod+shift+k" />
    </Button>
  );
}
