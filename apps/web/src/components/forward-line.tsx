import type { ForwardInfo } from "@terno/core";
import { t, translate } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Forward } from "@terno/ui/icons";
import { listDate } from "~/lib/format";
import { cancelForwards, retryForward, useForwards } from "~/lib/forwards";

const LIST_SHOWN = 2;

/** "Ana", "Ana and 2 more": who a forward goes to, as the reader says it. */
function names(list: readonly { name: string; email: string }[]): string {
  const shown = list.slice(0, LIST_SHOWN).map((a) => a.name || a.email).join(", ");
  return list.length > LIST_SHOWN ? t("forward.toMany", { name: shown, count: list.length - LIST_SHOWN }) : shown;
}

function sentence(f: ForwardInfo): string {
  const to = names(f.to);
  switch (f.status) {
    case "waiting":
      return t("forward.line.waiting", { to });
    case "held":
      return t("forward.line.held", { to });
    case "sending":
      return t("forward.line.sending", { to });
    case "sent":
      return t("forward.line.sent", { to });
    case "partial":
      return t("forward.line.partial", { to });
    case "failed":
      return f.reason ? translate({ key: f.reason }) : t("forward.line.failed", { to });
    case "unknown":
      return t("forward.line.unknown", { to });
    case "cancelled":
      return f.reason ? translate({ key: f.reason }) : t("forward.line.cancelled", { to });
  }
}

/** Plan 116: under a message, where its forwards are (waiting with Cancel, sent, failed with Retry). */
export function ForwardLine({ messageId }: { messageId: number }) {
  const list = useForwards((s) => s.byMessage.get(messageId));
  if (!list?.length) return null;
  return (
    <ul data-testid="forward-line" aria-label={t("forward.line.label")} className="mt-4 flex flex-col gap-1">
      {list.map((f) => (
        <li key={f.id} data-testid="forward-line-item" data-status={f.status} className="flex min-h-7 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <Forward className="size-[1.15em] shrink-0" aria-hidden />
          <span>{sentence(f)}</span>
          {f.status === "sent" && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular">{listDate(f.at)}</span>
            </>
          )}
          {f.filesMissing && (f.status === "sent" || f.status === "sending" || f.status === "partial") && <span>{t("forward.line.filesMissing")}</span>}
          {f.status === "waiting" && (
            <Button size="xs" variant="ghost" data-testid="forward-line-cancel" onClick={() => void cancelForwards([f.id])}>
              {t("common.cancel")}
            </Button>
          )}
          {f.status === "failed" && (
            <Button size="xs" variant="ghost" data-testid="forward-line-retry" onClick={() => void retryForward(f.id)}>
              {t("forward.retry")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
