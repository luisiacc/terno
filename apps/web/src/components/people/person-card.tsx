import { personItemId, personItemThread, type PersonPage } from "@terno/core";
import { t } from "@terno/i18n";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@terno/ui/components/dropdown-menu";
import { Mail } from "@terno/ui/icons";
import { listDate } from "~/lib/format";
import { openThread } from "~/lib/page";
import { noteOpen } from "~/lib/reminders";
import { formatNumber } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { personKey } from "@terno/core";
import { itemGlyph, itemParts, itemWhen } from "./person-item";

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
            <DropdownMenuLabel className="flex items-center gap-2">
              {t("people.between")}
              <Badge variant="neutral" className="tabular">
                {formatNumber(page.items.length)}
              </Badge>
            </DropdownMenuLabel>
            {items.map((item) => {
              const Glyph = itemGlyph(item);
              const when = itemWhen(item);
              const parts = itemParts(item);
              return (
                <DropdownMenuItem key={personItemId(item)} data-testid="person-card-item" onClick={() => go(personItemThread(item).id)} className="h-auto items-start py-1.5">
                  <Glyph className="mt-0.5" />
                  {/* what it is, on two lines at most, then its kind and its when, as the page says them */}
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 whitespace-normal">{parts.text}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-testid="person-card-item-status">
                      {parts.label}
                      {when.text && (
                        <>
                          {" · "}
                          <span className={when.late ? "text-destructive-ink tabular-nums" : "tabular-nums"}>{when.text}</span>
                        </>
                      )}
                    </span>
                  </span>
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
            <DropdownMenuLabel>{personKey(last.fromEmail) === page.key ? t("people.theyWroteLast", { name: last.fromName || page.name || page.email }) : t("people.youWroteLast")}</DropdownMenuLabel>
            <DropdownMenuItem data-testid="person-card-last-item" onClick={() => go(last.id)} className="h-auto items-start py-1.5">
              {/* (on the items' line: a glyph of its own) */}
              <Mail className="mt-0.5" />
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
