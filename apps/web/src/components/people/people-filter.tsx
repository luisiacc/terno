import { PEOPLE_WITHIN, type PeopleWithin } from "@terno/core";
import { t } from "@terno/i18n";
import { ListFilter } from "@terno/ui/icons";
import { Button } from "@terno/ui/components/button";
import { AccountMark } from "@terno/ui/components/category-dot";
import { Chip } from "@terno/ui/components/chip";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { useRef, useState } from "react";
import { peopleSolo, setPeopleFilter } from "~/lib/people";
import { accountsLabel, chosenAccounts, dateLabel, filterSummary, hasDate, NO_PEOPLE_FILTER, rangeLabel, toggleAccount, withinLabel, withoutDate } from "~/lib/people-filter";
import { useApp } from "~/state/app";
import { usePeople } from "~/state/people";
import { PeopleRangePicker } from "./people-range";

const ANY = "any";
const CUSTOM = "custom";

/** Where the keyboard goes when a chip it was on goes: the filter's button (plan 287) */
const focusButton = () => document.querySelector<HTMLElement>("[data-testid=people-filter]")?.focus({ preventScroll: true });

/**
 * Plan 287: People's filter, at the end of its title line: the date of the last email with them (one of a few periods) and,
 * for People of every account, which accounts (several, the menu staying open while they're ticked). On while a filter is
 * on, as the mail list's own filter button is.
 */
export function PeopleFilterButton() {
  const choice = usePeople((s) => s.filter);
  const accounts = useApp((s) => s.accounts);
  const solo = useApp((s) => peopleSolo(s) !== null);
  const summary = filterSummary(choice, accounts, solo);
  const chosen = solo ? [] : chosenAccounts(choice, accounts);
  // (a focused account's People is that account's: no other to choose, plan 287)
  const withAccounts = !solo && accounts.length > 1;
  const name = summary ? t("people.filter.buttonOn", { what: summary }) : t("people.filter.button");
  // plan 287: Custom range… opens its picker under this button once the menu has gone (and given the keyboard back)
  const button = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const pick = useRef(false);
  return (
    <>
    <DropdownMenu
      onOpenChangeComplete={(open) => {
        if (open || !pick.current) return;
        pick.current = false;
        setPicking(true);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  ref={button}
                  data-testid="people-filter"
                  data-active={summary ? true : undefined}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={name}
                  className={cn("no-drag shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground", summary && "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground")}
                />
              }
            />
          }
        >
          <ListFilter />
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" data-testid="people-filter-menu" className="max-h-(--available-height) w-auto max-w-72 min-w-52 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("people.filter.date")}</DropdownMenuLabel>
          {/* a period clears a range, as a range clears a period; Custom range… opens its picker, chosen or not */}
          <DropdownMenuRadioGroup value={choice.range ? CUSTOM : (choice.within ?? ANY)} onValueChange={(v) => v !== CUSTOM && setPeopleFilter({ ...choice, range: null, within: v === ANY ? null : (v as PeopleWithin) })}>
            {[ANY, ...PEOPLE_WITHIN].map((w) => (
              <DropdownMenuRadioItem key={w} value={w} closeOnClick data-testid={`people-filter-${w}`}>
                {withinLabel(w === ANY ? null : (w as PeopleWithin))}
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value={CUSTOM} closeOnClick data-testid="people-filter-custom" onClick={() => (pick.current = true)}>
              <span className="min-w-0 flex-1 truncate">{t("people.filter.custom")}</span>
              {choice.range && <span className="shrink-0 text-muted-foreground tabular">{rangeLabel(choice.range)}</span>}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {withAccounts && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("people.filter.accounts")}</DropdownMenuLabel>
              {/* ticking accounts keeps the menu open: several are chosen in one go */}
              <DropdownMenuCheckboxItem checked={chosen.length === 0} onCheckedChange={() => setPeopleFilter({ ...choice, accounts: [] })} data-testid="people-filter-all-accounts">
                {/* the diamond's room, so its words stand on the accounts' names' line */}
                <AccountMark color="slate" className="invisible" />
                {t("people.filter.allAccounts")}
              </DropdownMenuCheckboxItem>
              {accounts.map((a) => (
                <DropdownMenuCheckboxItem key={a.id} checked={chosen.some((c) => c.id === a.id)} onCheckedChange={() => setPeopleFilter(toggleAccount(choice, a.id, accounts))} data-testid={`people-filter-account-${a.id}`}>
                  <AccountMark color={a.color} />
                  <span className="min-w-0 flex-1 truncate">{a.displayName}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {summary && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="people-filter-clear-menu" onClick={() => setPeopleFilter(solo ? withoutDate(choice) : NO_PEOPLE_FILTER)}>
              {t("people.filter.clear")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    <PeopleRangePicker open={picking} onOpenChange={setPicking} anchor={button} />
    </>
  );
}

/**
 * Plan 287: what the filter keeps out, said under People's subtitle while one is on: a chip per part (the date, the accounts),
 * each with its own ×. Nothing while none is.
 */
export function PeopleFilterChips() {
  const choice = usePeople((s) => s.filter);
  const accounts = useApp((s) => s.accounts);
  const solo = useApp((s) => peopleSolo(s) !== null);
  const chosen = solo ? [] : chosenAccounts(choice, accounts);
  if (!hasDate(choice) && !chosen.length) return null;
  const date = dateLabel(choice);
  const named = chosen.length ? accountsLabel(chosen) : null;
  // (the × the keyboard was on goes with its chip: the keyboard to the filter's button)
  const remove = (next: typeof choice) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const had = e.currentTarget === document.activeElement || e.detail === 0;
    setPeopleFilter(next);
    if (had) requestAnimationFrame(focusButton);
  };
  return (
    // (no-drag: the header is the window's drag region, and a × in it would move the window, Codex code review)
    <div data-testid="people-filter-chips" className="no-drag flex min-w-0 flex-wrap items-center gap-1.5 pb-2 pl-3">
      {date && (
        <Chip data-testid="people-filter-chip-date" onRemove={remove(withoutDate(choice))} removeLabel={t("people.filter.remove", { what: date })}>
          {date}
        </Chip>
      )}
      {named && (
        <Chip data-testid="people-filter-chip-accounts" title={chosen.map((a) => a.displayName).join(", ")} dot={chosen.length === 1 ? <AccountMark color={chosen[0]!.color} /> : undefined} onRemove={remove({ ...choice, accounts: [] })} removeLabel={t("people.filter.remove", { what: named })}>
          {named}
        </Chip>
      )}
    </div>
  );
}

/** Plan 287: the list holds nobody under a filter: says so, with the way out. */
export function PeopleFilterEmpty() {
  const choice = usePeople((s) => s.filter);
  const solo = useApp((s) => peopleSolo(s) !== null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {t("people.filter.none")}
      <Button
        ref={button}
        variant="link-secondary"
        size="xs"
        data-testid="people-filter-clear"
        className="px-0"
        onClick={(e) => {
          const had = e.currentTarget === document.activeElement || e.detail === 0;
          setPeopleFilter(solo ? withoutDate(choice) : NO_PEOPLE_FILTER);
          if (had) requestAnimationFrame(focusButton);
        }}
      >
        {t("people.filter.clear")}
      </Button>
    </span>
  );
}
