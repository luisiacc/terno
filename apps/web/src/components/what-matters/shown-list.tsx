import type { ShownSender } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useId, useRef } from "react";
import { stopShowing } from "~/lib/shown-senders";
import { readShownSenders, useShownSenders } from "~/state/shown-senders";

/**
 * Plan 240: the senders always shown in What matters, each with Stop (Undo in the snack), where What matters' settings are.
 * A sender's name, their address beside it (never twice). Stop takes the row off at once and keeps the keys in the list: the
 * next row's button, else the previous, else `fallback`. Nothing shown: nothing drawn (a sender's menu is the way in).
 */
export function ShownList({ testId, labelledBy, describedBy, fallback }: { testId: string; labelledBy?: string; describedBy?: string; fallback?: () => HTMLElement | null }) {
  const senders = useShownSenders((s) => s.senders);
  const list = useRef<HTMLUListElement>(null);
  const baseId = useId();
  useEffect(() => void readShownSenders(), []);
  if (!senders?.length) return null;
  const stop = async (s: ShownSender, at: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>(`[data-testid=${testId}-stop]`) ?? [])];
    const next = buttons[at + 1] ?? buttons[at - 1] ?? fallback?.() ?? null;
    useShownSenders.setState(({ senders: held }) => ({ senders: held && held.filter((x) => x.key !== s.key) }));
    next?.focus({ preventScroll: true });
    // failed: back where it was
    if (!(await stopShowing(s))) useShownSenders.setState(({ senders: held }) => ({ senders: held && [...held.filter((x) => x.key !== s.key), s].sort((a, b) => b.at - a.at) }));
  };
  return (
    <ul ref={list} aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col" data-testid={testId}>
      {senders.map((s, i) => {
        const name = s.name.trim() || s.email;
        const nameId = `${baseId}-${i}`;
        return (
          <li key={s.key} className="flex min-h-9 items-center gap-3 border-b border-hairline py-1 last:border-b-0" data-testid={`${testId}-item`}>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span id={nameId} className="font-medium">{name}</span>
              {name !== s.email && <span className="ml-2 text-xs text-muted-foreground">{s.email}</span>}
            </span>
            <Button variant="link-secondary" size="xs" className="shrink-0" aria-describedby={nameId} data-testid={`${testId}-stop`} onClick={() => void stop(s, i)}>
              {t("shown.stop")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
