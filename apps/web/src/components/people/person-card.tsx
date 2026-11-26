import { personItemId, personItemThread, type PersonPage } from "@terno/core";
import { t } from "@terno/i18n";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut } from "@terno/ui/components/dropdown-menu";
import { listDate } from "~/lib/format";
import { openThread } from "~/lib/page";
import { noteOpen } from "~/lib/reminders";
import { itemGlyph, itemLine, itemWhen } from "./person-item";

/** the card's open items, at most (their page has the rest) */
const SHOWN = 4;

/**
 * Plan 281 (proposal A): the person card, in the head of a chip's menu: what's open between you (each item opens its
 * conversation) and the last time you wrote each other (another conversation than this one: its subject, its day, and its
 * stored summary's first sentence when there is one). Drawn only with what was read before the menu opened.
 */
export function PersonCardHead({ page, threadId }: { page: PersonPage; threadId: number }) {
  const items = page.items.slice(0, SHOWN);
  const last = page.conversations.find((c) => c.id !== threadId);
  // the summary the backend read is of the newest other conversation: said only for that one
  const summary = last && last.id === page.lastSummaryOf ? page.lastSummary : undefined;
  if (!items.length && !last) return null;
  const go = (id: number) => {
    noteOpen(id);
    openThread(id);
  };
  return (
    <>
      {items.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup data-testid="person-card-open">
            <DropdownMenuLabel>{t("people.between")}</DropdownMenuLabel>
            {items.map((item) => {
              const Glyph = itemGlyph(item);
              const when = itemWhen(item);
              return (
                <DropdownMenuItem key={personItemId(item)} data-testid="person-card-item" onClick={() => go(personItemThread(item).id)}>
                  <Glyph />
                  <span className="min-w-0 flex-1 truncate">{itemLine(item)}</span>
                  {when.text && <DropdownMenuShortcut className={when.late ? "tracking-normal text-destructive-ink tabular-nums" : "tracking-normal tabular-nums"}>{when.text}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </>
      )}
      {last && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup data-testid="person-card-last">
            <DropdownMenuLabel>{t("people.lastTime")}</DropdownMenuLabel>
            <DropdownMenuItem data-testid="person-card-last-item" onClick={() => go(last.id)} className="items-start">
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{last.subject || t("common.noSubject")}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{listDate(last.lastDate)}</span>
                </span>
                {summary && <span className="mt-0.5 line-clamp-2 text-xs whitespace-normal text-muted-foreground">{summary}</span>}
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </>
      )}
    </>
  );
}
