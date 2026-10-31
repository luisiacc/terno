import type { AlwaysScope } from "@terno/core";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@terno/ui/components/dropdown-menu";
import { t } from "@terno/i18n";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { answerReview, fileAlways, filterNameOf } from "~/lib/categorize";
import { scopeLabel } from "~/lib/similar";
import { client } from "~/rpc/connection";
import { formatCount } from "./category-snackbar";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

/** The one "Always" menu of the Review list: which row's button opened it (rows hold no Base UI primitives). */
const useAlwaysMenu = create<{ threadId: number | null; anchor: HTMLElement | null }>(() => ({ threadId: null, anchor: null }));

const listbox = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]");

type Offers = { senderName: string | null; offers: { scope: AlwaysScope; count: number; capped: boolean }[] };

/** Pressing a row control neither opens the thread, moves focus nor starts a drag (`data-row-control`). */
const hold = (e: React.MouseEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

/**
 * Plan 80: a Review row's two answers, in words: "Add to C" (it belongs) and
 * "Add similar ▾" (the same subject or everything from the sender, now and in
 * the future). They take the place of the row's preview line. Pointer targets
 * like the code chip: a row is an option, which can't hold a button; keyboards
 * answer with y/n and the thread menu's same items.
 */
export function ReviewControls({ threadId, categoryId, category }: { threadId: number; categoryId: number; category: string }) {
  const pill = "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-fast";
  return (
    <span aria-hidden className="flex min-w-0 items-center gap-1.5">
      <span
        data-testid="row-review-accept"
        data-row-control
        title={t("review.accept", { category })}
        onMouseDown={hold}
        onClick={(e) => {
          e.stopPropagation();
          void answerReview(threadId, categoryId, true);
        }}
        className={`${pill} bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary)_88%,var(--background))]`}
      >
        <Check className="size-3.5 shrink-0" />
        <span className="truncate">{t("review.accept", { category })}</span>
      </span>
      <span
        data-testid="row-review-always"
        data-row-control
        title={t("review.similar.title", { category })}
        onMouseDown={hold}
        onClick={(e) => {
          e.stopPropagation();
          useAlwaysMenu.setState({ threadId, anchor: e.currentTarget });
        }}
        className={`${pill} shrink-0 border border-border bg-background text-foreground hover:bg-muted`}
      >
        {t("review.similar")}
        <ChevronDown className="size-3.5" />
      </span>
    </span>
  );
}

/** The Review list's "Always add to C" menu: same subject from the sender first, then all from them, counted when it opens. */
export function ReviewAlwaysMenu() {
  const { threadId, anchor } = useAlwaysMenu();
  const category = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const open = threadId !== null && anchor !== null && category !== undefined;
  const [offers, setOffers] = useState<Offers | "loading" | "failed">("loading");
  const close = () => useAlwaysMenu.setState({ threadId: null, anchor: null });

  // global shortcuts wait while it is open (as for the thread menu)
  useEffect(() => {
    if (!open) return;
    setApp({ menuOpen: true });
    return () => setApp({ menuOpen: false });
  }, [open]);

  useEffect(() => {
    if (!open || !category) return;
    let alive = true;
    setOffers("loading");
    client.call("categorize.alwaysOffers", { categoryId: category.id, threadId }).then(
      (r) => alive && setOffers(r),
      () => alive && setOffers("failed"),
    );
    return () => {
      alive = false;
    };
  }, [threadId, category?.id]);

  // its row left the list (answered elsewhere, a sync, another view): the menu goes with it
  useEffect(() => {
    if (threadId === null) return;
    const gone = () => !useList.getState().index.has(threadId) || getApp().reviewCategoryId === null;
    if (gone()) return close();
    const offList = useList.subscribe(() => gone() && close());
    const offApp = useApp.subscribe(() => gone() && close());
    return () => {
      offList();
      offApp();
    };
  }, [threadId]);

  if (!open) return null;
  const list = typeof offers === "object" ? offers.offers : [];
  return (
    <DropdownMenu
      open
      onOpenChange={(next) => {
        if (next) return;
        close();
        // a press outside leaves focus nowhere (Base UI restores none then): the list takes it back, a frame later
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) listbox()?.focus({ preventScroll: true });
        });
      }}
    >
      <DropdownMenuContent
        anchor={anchor}
        align="end"
        className="w-72"
        data-testid="review-always-menu"
        // back to the list, where the user was (the row's control is no focus target); focus the user already moved
        // elsewhere (a click into search or the composer) stays there, as the thread menu does
        finalFocus={() => {
          const active = document.activeElement;
          if (active && active !== document.body && !active.closest("[role=menu]")) return false;
          return listbox() ?? true;
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-foreground">{t("review.always", { category: category.name })}</span>
            <span className="text-2xs font-normal">{t("review.always.future")}</span>
          </DropdownMenuLabel>
          {offers === "loading" ? (
            <DropdownMenuItem disabled data-testid="review-always-loading">
              <span className="h-3 w-40 animate-pulse rounded bg-muted" />
            </DropdownMenuItem>
          ) : list.length === 0 ? (
            <DropdownMenuItem disabled data-testid="review-always-none">
              {offers === "failed" ? t("review.always.failed") : t("review.always.none")}
            </DropdownMenuItem>
          ) : (
            list.map((o) => (
              <DropdownMenuItem
                key={o.scope.kind}
                data-testid={`review-always-${o.scope.kind}`}
                title={o.scope.kind === "subject" ? o.scope.subject : undefined}
                onClick={() => {
                  const sender = (offers as Offers).senderName;
                  close();
                  void fileAlways(category.id, o.scope, threadId, filterNameOf(o.scope, sender, category.name));
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{scopeLabel(o.scope, (offers as Offers).senderName)}</span>
                  {o.scope.kind === "subject" && <span className="truncate text-2xs text-muted-foreground">{o.scope.subject}</span>}
                </span>
                <span data-testid={`review-always-${o.scope.kind}-count`} className="shrink-0 font-mono text-2xs text-muted-foreground tabular">
                  {formatCount(o)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** For the thread menu: the same offers, asked for when it opens on a Review row. */
export function useAlwaysOffers(threadId: number | null, categoryId: number | null): Offers | null {
  const [offers, setOffers] = useState<Offers | null>(null);
  useEffect(() => {
    setOffers(null);
    if (threadId === null || categoryId === null) return;
    let alive = true;
    client.call("categorize.alwaysOffers", { categoryId, threadId }).then(
      (r) => alive && setOffers(r),
      () => alive && setOffers({ senderName: null, offers: [] }),
    );
    return () => {
      alive = false;
    };
  }, [threadId, categoryId]);
  return offers;
}
