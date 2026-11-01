import type { Account, Folder } from "@terno/core";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Download, Folder as FolderIcon, FolderPlus, PenLine, Plus, Star, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { lazy, Suspense, useId, useRef, useState, type ReactElement } from "react";
import { isFavorite, nameProblem, setFavorite, startCreate, startRename, type FolderTarget } from "~/lib/folders";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";

const FolderDeleteDialog = lazy(() => import("./folder-delete-dialog").then((m) => ({ default: m.FolderDeleteDialog })));

/**
 * Plan 107: the "+" at a row's far right, shown on hover (an open account's row, an own folder's). Not a tab stop:
 * a long folder list doesn't double its stops; the account and folder menus have "New folder…" for the keyboard.
 */
export function AddFolderButton({ accountId, parent, label, testId }: { accountId: number; parent: string | null; label: string; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={label}
            data-testid={testId}
            onClick={() => startCreate(accountId, parent)}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          />
        }
      >
        <Plus className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Plan 107: a folder's name being typed, in place: a new folder where it will be, or a rename where the name was.
 * The row's shape and the name's line (`inset`: the row's indent). Enter submits, Esc cancels, leaving submits
 * what was typed (nothing typed: cancels). A problem is said under the field and the text stays; while the server
 * answers the field waits, dimmed. `submit` resolves to null when done, or to what went wrong.
 */
export function FolderNameRow({
  initial,
  label,
  inset,
  testId,
  siblings,
  account,
  submit,
  cancel,
}: {
  initial: string;
  label: string;
  inset: string;
  testId: string;
  siblings: readonly Folder[];
  account: Pick<Account, "kind">;
  submit: (name: string) => Promise<string | null>;
  cancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // one answer per edit (Codex R6 of plan 106: the blur after Enter isn't a second submit)
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const finish = async (value: string | null, fromBlur: boolean) => {
    if (settled.current || busy) return;
    if (value === null || (fromBlur && (!value.trim() || value.trim() === initial))) {
      settled.current = true;
      return cancel();
    }
    if (value.trim() === initial && initial) {
      settled.current = true;
      return cancel();
    }
    const problem = nameProblem(value, siblings, account);
    if (problem) return setError(problem);
    setBusy(true);
    const failed = await submit(value);
    setBusy(false);
    if (failed === null) {
      settled.current = true;
      return;
    }
    setError(failed);
    // back to the field only if the focus is nowhere else (Codex R8: the user may have moved on)
    if (document.activeElement === document.body || document.activeElement === input.current) input.current?.focus();
  };
  return (
    <div data-testid={`${testId}-row`} className="min-w-0">
      {/* the indent replaces the row's own left padding, as a folder row's does: the icon sits on its siblings' line */}
      <div className={cn("type-nav flex h-(--nav-h) min-w-0 items-center gap-2.5 px-2 text-sidebar-foreground", inset)}>
        <span className="flex size-4 items-center justify-center text-sidebar-glyph">
          <FolderIcon className="size-4" />
        </span>
        {/* the text starts where a name does: the field's padding sits outside the label's line */}
        <input
          ref={input}
          autoFocus
          data-testid={testId}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-busy={busy || undefined}
          readOnly={busy}
          defaultValue={initial}
          maxLength={1000}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={() => error && setError(null)}
          onKeyDown={(e) => {
            // the field's keys are its own: never a row's or a shortcut
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void finish(e.currentTarget.value, false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void finish(null, false);
            }
          }}
          onBlur={(e) => void finish(e.currentTarget.value, true)}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn("-mx-1 h-[calc(var(--nav-h)-6px)] min-w-0 flex-1 rounded-sm bg-background px-1 text-foreground ring-2 ring-ring outline-none", busy && "opacity-60", error && "ring-destructive")}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" data-testid={`${testId}-error`} className={cn("px-2 pb-1 text-xs text-destructive-ink", inset)}>
          {/* under the name: past the icon and its gap */}
          <span className="block pl-6.5">{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Plan 107: a folder's right-click menu (and Shift+F10, plan 106): an own folder's New subfolder…, Rename,
 * favorite, Export mailbox… and Delete folder…; a standard row's favorite and export. A favorite's row has the same.
 */
export function FolderMenu({ target, name, account, children }: { target: FolderTarget; name: string; account: Account; children: ReactElement }) {
  const favorites = useApp((s) => s.settings?.favoriteFolders);
  const favorite = isFavorite(favorites, target);
  // mounted from the first Delete… on, so the dialog can animate out after
  const [deleting, setDeleting] = useState<boolean | null>(null);
  // an item that moves the focus itself (a name field, a dialog) keeps the closing menu from handing it back (plan 106)
  const [handOff, setHandOff] = useState(false);
  const away = (run: () => void) => () => {
    setHandOff(true);
    run();
  };
  const own = target.folder !== null;
  const id = `${target.accountId}-${target.folder ?? target.view}`;
  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) setHandOff(false);
          setApp({ menuOpen: open });
        }}
      >
        <ContextMenuTrigger data-context-menu render={children} />
        <ContextMenuContent className="w-56" data-testid={`folder-menu-${id}`} finalFocus={handOff ? false : undefined}>
          {own && (
            <>
              <ContextMenuItem data-testid="folder-menu-new" onClick={away(() => startCreate(target.accountId, target.folder))}>
                <FolderPlus />
                <span className="flex-1">{t("folder.menu.newSubfolder")}</span>
              </ContextMenuItem>
              <ContextMenuItem data-testid="folder-menu-rename" onClick={away(() => startRename(target.accountId, target.folder!))}>
                <PenLine />
                <span className="flex-1">{t("folder.menu.rename")}</span>
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            data-testid="folder-menu-favorite"
            onClick={() =>
              void setFavorite(target, !favorite).catch((e: unknown) => snack.error(t("folder.favoriteFailed", { error: e instanceof Error ? e.message : String(e) })))
            }
          >
            <Star />
            <span className="flex-1">{favorite ? t("folder.menu.unfavorite") : t("folder.menu.favorite")}</span>
          </ContextMenuItem>
          <ContextMenuItem data-testid="folder-menu-export" onClick={() => void import("~/lib/export-folder").then((m) => m.exportFolder(target, name))}>
            <Download />
            <span className="flex-1">{t("folder.menu.export")}</span>
          </ContextMenuItem>
          {own && (
            <>
              <ContextMenuSeparator />
              {/* a plain item, as in macOS menus: the confirmation is where it reads as destructive */}
              <ContextMenuItem data-testid="folder-menu-delete" onClick={away(() => setDeleting(true))}>
                <Trash2 />
                <span className="flex-1">{t("folder.menu.delete")}</span>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {own && deleting !== null && (
        <Suspense fallback={null}>
          <FolderDeleteDialog account={account} folderKey={target.folder!} name={name} open={deleting} onOpenChange={setDeleting} />
        </Suspense>
      )}
    </>
  );
}
