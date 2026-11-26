import { personItemId, personItemThread, type PersonPage } from "@terno/core";
import { t } from "@terno/i18n";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@terno/ui/components/dropdown-menu";
import { Check, Clock, Mail } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { actOnCardItem } from "~/lib/people";
import { listDate } from "~/lib/format";
import { openThread } from "~/lib/page";
import { noteOpen } from "~/lib/reminders";
import { formatNumber } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { personKey } from "@terno/core";
import { itemGlyph, itemParts, itemTone, itemWhen, LaterChoices, personLaterPresets } from "./person-item";

/** the card's open items, at most (their page has the rest) */
const SHOWN = 4;

/** a card item's Done and Later: the page's words, small menu items under the item's text (r04: icons alone read as states) */
const ACTION_ITEM = "h-6 w-auto gap-1 px-2 text-xs text-foreground-soft data-highlighted:text-foreground";

/**
 * Plan 281 (proposal A): the person card, in the head of a chip's menu: what's open between you (each item opens its
 * conversation; its Done and Later beside it, owner after the QA panel: finished without leaving the conversation) and
 * the last time you wrote each other (another conversation than this one: its subject, its day, and its
 * stored summary's first sentence when there is one). Drawn only with what was read before the menu opened.
 */
export function PersonCardHead({ page, threadId }: { page: PersonPage; threadId: number }) {
  const now = page.items.filter((i) => !itemWhen(i).later);
  const items = now.slice(0, SHOWN);
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
                {formatNumber(now.length)}
              </Badge>
            </DropdownMenuLabel>
            {items.map((item) => {
              const Glyph = itemGlyph(item);
              const when = itemWhen(item);
              const parts = itemParts(item);
              const stamp = Date.now();
              return (
                <div key={personItemId(item)} data-testid="person-card-row">
                  <DropdownMenuItem data-testid="person-card-item" onClick={() => go(personItemThread(item).id)} className="h-auto min-w-0 items-start py-1.5">
                    <Glyph className={cn("mt-0.5", itemTone(item))} />
                    {/* what it is, on two lines at most, then its kind and its when, as the page says them */}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 whitespace-normal">{parts.text}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-testid="person-card-item-status">
                        {parts.quiet ? <span className="sr-only">{parts.label}</span> : parts.label}
                        {when.text && (
                          <>
                            {parts.quiet ? null : " · "}
                            <span className={when.late ? "text-destructive-ink tabular-nums" : "tabular-nums"}>{when.text}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </DropdownMenuItem>
                  {/* (on the text's line: after the glyph's width) */}
                  <div className="flex items-center gap-0.5 ps-[calc(1.15em+0.5rem)] pb-1">
                    <DropdownMenuItem data-testid="person-card-done" aria-label={t("people.card.done", { text: parts.text })} onClick={() => void actOnCardItem(item, "done")} className={ACTION_ITEM}>
                      <Check />
                      {t("dated.done")}
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger data-testid="person-card-later" aria-label={t("people.card.later", { text: parts.text })} className={ACTION_ITEM}>
                        <Clock />
                        {t("dated.later")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-max min-w-56" data-testid="person-card-later-menu">
                        <LaterChoices item={item} presets={personLaterPresets(item, stamp)} now={stamp} via="card" testPrefix="person-card-later" />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </div>
                </div>
              );
            })}
          </DropdownMenuGroup>
        </>
      )}
      {last && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup data-testid="person-card-last">
            <DropdownMenuLabel>{t("people.lastConversation")}</DropdownMenuLabel>
            <DropdownMenuItem data-testid="person-card-last-item" onClick={() => go(last.id)} className="h-auto items-start py-1.5">
              {/* (on the items' line: a glyph of its own) */}
              <Mail className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{last.subject || t("common.noSubject")}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{listDate(last.lastDate)}</span>
                </span>
                {/* who wrote its last message: you, them, or whoever else is on it */}
                <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-testid="person-card-last-by">
                  {page.lastFromMe ? t("people.youWroteLast") : t("people.theyWroteLast", { name: personKey(last.fromEmail) === page.key ? last.fromName || page.name || page.email : last.fromName || last.fromEmail })}
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
