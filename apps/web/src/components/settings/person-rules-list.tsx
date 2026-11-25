import type { PersonRule } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useId, useRef } from "react";
import { choosePerson } from "~/lib/person-rules";
import { readPersonRules, usePersonRules } from "~/state/person-rules";

/**
 * Plan 278: the senders you've said are or aren't people, each with Reset (Terno decides again; Undo in the snack). A sender's
 * name, their address beside it (never twice), and your choice. Reset takes the row off at once and keeps the keys in the
 * list: the next row's button, else the previous, else `fallback` (Codex review #9). None: how one comes to be here.
 */
export function PersonRulesList({ testId, labelledBy, describedBy, fallback }: { testId: string; labelledBy?: string; describedBy?: string; fallback: () => HTMLElement | null }) {
  const rules = usePersonRules((s) => s.rules);
  const list = useRef<HTMLUListElement>(null);
  const baseId = useId();
  useEffect(() => void readPersonRules(), []);
  if (rules === null) return null;
  if (!rules.length) return <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>{t("personRules.empty")}</p>;
  const reset = async (r: PersonRule, at: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>(`[data-testid=${testId}-reset]`) ?? [])];
    const next = buttons[at + 1] ?? buttons[at - 1] ?? fallback();
    usePersonRules.setState(({ rules: held }) => ({ rules: held && held.filter((x) => x.key !== r.key) }));
    next?.focus({ preventScroll: true });
    // failed: back where it was
    if (!(await choosePerson(r, "auto"))) usePersonRules.setState(({ rules: held }) => ({ rules: held && [...held.filter((x) => x.key !== r.key), r].sort((a, b) => b.at - a.at) }));
  };
  return (
    <ul ref={list} aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col" data-testid={testId}>
      {rules.map((r, i) => {
        const name = r.name.trim() || r.email;
        const nameId = `${baseId}-${i}`;
        return (
          <li key={r.key} className="flex min-h-9 items-center gap-3 border-b border-hairline py-1 last:border-b-0" data-testid={`${testId}-item`}>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span id={nameId} className="font-medium">{name}</span>
              {name !== r.email && <span className="ml-2 text-xs text-muted-foreground">{r.email}</span>}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground" data-testid={`${testId}-choice`}>{t(r.person ? "personRules.isPerson" : "personRules.notPerson")}</span>
            <Button variant="link-secondary" size="xs" className="shrink-0" aria-describedby={nameId} data-testid={`${testId}-reset`} onClick={() => void reset(r, i)}>
              {t("personRules.reset")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
