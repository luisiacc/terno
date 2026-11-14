import { datedGroup, datedPlace, dayEnd, planEnd, type DatedRow, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useState } from "react";
import { aiAllowed } from "~/lib/ai";
import { actOnDated, datedLine } from "~/lib/dated";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { AI_CARD, AI_INSET, AI_TITLE } from "./ai-card";

/** The reader shows this many of a conversation's dates, soonest first. */
const SHOWN = 3;

/** Still to act on, shown or not yet in Today: not a Plan that's over, nor a day Missed has let go of. */
function current(r: DatedRow, now: number): { missed: boolean } | null {
  if (r.state !== "open") return null;
  const place = datedPlace(r, now);
  if (place === "missed") return { missed: true };
  if (place !== "hidden") return { missed: false };
  // hidden: too far ahead (or put off with Later) is still the conversation's; over is not
  return now < (datedGroup(r.kind) === "plans" ? planEnd(r) : dayEnd(r.dueDay)) ? { missed: false } : null;
}

/**
 * Plan 204 §5: the conversation's open dates, a quiet line each on the AI card's surface at its top ("Due Friday · Pay the
 * electricity bill", Done and Not a task), so a bill can be finished where it's read. Only while dates are read; never in Trash or
 * Spam; read again when Today changes (Done here, there, or a new message settling it).
 */
export default function ThreadDated({ detail }: { detail: ThreadDetail }) {
  const on = useApp((s) => aiAllowed(s) && s.settings?.dated?.enabled === true);
  const threadId = detail.thread.id;
  const hidden = detail.thread.inTrash || detail.thread.inSpam;
  const [rows, setRows] = useState<readonly DatedRow[]>([]);
  useEffect(() => {
    if (!on || hidden) return setRows([]);
    let live = true;
    const read = () => void client.call("dated.ofThread", { threadId }).then((r) => live && setRows(r.rows), () => {});
    read();
    const off = client.on("todayChanged", read);
    return () => {
      live = false;
      off();
    };
  }, [on, hidden, threadId]);
  const now = Date.now();
  const shown = rows
    .map((r) => ({ r, at: current(r, now) }))
    .filter((x): x is { r: DatedRow; at: { missed: boolean } } => x.at !== null)
    .sort((a, b) => a.r.dueAt - b.r.dueAt)
    .slice(0, SHOWN);
  if (!shown.length) return null;
  return (
    // the summary card's surface and inset (plan 181): a model's reading, not the sender's words
    <section aria-label={t("dated.section")} data-testid="thread-dated" className={cn(AI_CARD, AI_INSET, "mb-4")}>
      <ul>
        {shown.map(({ r, at }) => {
          const line = datedLine(r, at.missed, now);
          return (
            <li key={r.id} data-testid="thread-dated-item" data-kind={r.kind} className="flex min-h-11 items-center gap-3 text-sm">
              <span data-testid="thread-dated-text" className={cn(AI_TITLE, "min-w-0 flex-1 wrap-anywhere tabular")}>{line}</span>
              {/* after the panel: Not a task beside Done, quieter (Done is what's usually meant) */}
              <span className="flex shrink-0 items-center gap-1.5">
                <Button variant="outline" size="sm" className="text-foreground" data-testid="thread-dated-done" aria-label={t("dated.doneItem", { text: r.text })} onClick={() => void actOnDated(r, "done")}>
                  {t("dated.done")}
                </Button>
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" data-testid="thread-dated-dismiss" aria-label={t("dated.notTaskItem", { text: r.text })} onClick={() => void actOnDated(r, "dismiss")}>
                  {t("dated.notTask")}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
