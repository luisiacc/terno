import type { Account, FavoriteFolder, Folder } from "@terno/core";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Download, Folder as FolderIcon, FolderPlus, PenLine, Plus, Star, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { isFavorite, setFieldDraft, useFieldDrafts, nameProblem, setFavorite, startCreate, startRename, type FolderTarget } from "~/lib/folders";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { FolderDeleteDialog } from "./folder-delete-dialog";
import { exportFolder } from "~/lib/export-folder";


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

/** how many fields of each edit are on screen (a row back while its answer comes shows the failure itself) */
const shownFields = new Map<number, number>();

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
  editId,
}: {
  initial: string;
  label: string;
  inset: string;
  testId: string;
  siblings: readonly Folder[];
  account: Pick<Account, "kind">;
  submit: (name: string) => Promise<string | null>;
  /** the edit it belongs to: its text and error outlive the row (fieldDrafts) */
  editId: number;
  /** "escape": the user asked (focus goes back to the row); "blur": they went elsewhere (focus stays there) */
  cancel: (how: "escape" | "blur") => void;
}) {
  // its text, error and whether its answer is on the way live with the edit, not the row (round 2 #3, round 3 #4)
  const draft = useFieldDrafts((s) => s[editId]);
  const error = draft?.error ?? null;
  const busy = draft?.pending ?? false;
  useEffect(() => {
    shownFields.set(editId, (shownFields.get(editId) ?? 0) + 1);
    return () => void shownFields.set(editId, shownFields.get(editId)! - 1);
  }, [editId]);
  // the edit's first field takes the focus; one mounted again later (its row moved: an IMAP rename's new key, an
  // account opened again) only if nothing else has it (Codex code review round 6 #3: never stolen back)
  useLayoutEffect(() => {
    const first = !useFieldDrafts.getState()[editId]?.focused;
    const free = !document.activeElement || document.activeElement === document.body;
    if (first || free) input.current?.focus();
    if (first) setFieldDraft(editId, { focused: true, text: useFieldDrafts.getState()[editId]?.text ?? "" });
  }, [editId]);
  // one answer per edit (Codex R6 of plan 106: the blur after Enter isn't a second submit)
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const finish = async (value: string | null, fromBlur: boolean) => {
    if (settled.current || useFieldDrafts.getState()[editId]?.pending) return;
    if (value === null || (fromBlur && (!value.trim() || value.trim() === initial))) {
      settled.current = true;
      return cancel(fromBlur ? "blur" : "escape");
    }
    if (value.trim() === initial && initial) {
      settled.current = true;
      return cancel(fromBlur ? "blur" : "escape");
    }
    const problem = nameProblem(value, siblings, account);
    if (problem) return setFieldDraft(editId, { text: value, error: problem });
    setFieldDraft(editId, { text: value, error: null, pending: true });
    const failed = await submit(value);
    if (failed === null) {
      settled.current = true;
      return;
    }
    setFieldDraft(editId, { text: value, error: failed, pending: false });
    // no field of this edit on screen (its account closed): the text waits for it, and the failure is said now
    if (!shownFields.get(editId)) return void snack.error(t("folder.saveFailed", { name: value.trim(), error: failed }));
    // back to the field only if the focus is nowhere else (Codex R8: the user may have moved on)
    if (document.activeElement === document.body || document.activeElement === input.current) input.current?.focus();
  };
  return (
    <div data-testid={`${testId}-row`} className="min-w-0">
      {/* the indent replaces the row's own left padding, as a folder row's does: the icon sits on its siblings' line */}
      <div className={cn("type-nav flex h-(--nav-h) min-w-0 items-center gap-2.5 px-2 text-sidebar-foreground", inset)}>
        <span className="flex size-(--icon-nav) items-center justify-center text-sidebar-glyph">
          <FolderIcon className="size-(--icon-nav)" />
        </span>
        {/* the text starts where a name does: the field's padding sits outside the label's line */}
        <input
          ref={input}
          data-testid={testId}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-busy={busy || undefined}
          readOnly={busy}
          defaultValue={draft?.text || initial}
          maxLength={1000}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setFieldDraft(editId, { text: e.currentTarget.value, error: null })}
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
          className={cn("-mx-1 h-[calc(var(--nav-h)-6px)] min-w-0 flex-1 rounded-sm bg-background px-1 text-foreground ring-2 ring-ring outline-none", busy && "text-muted-foreground", error && "ring-destructive")}
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
 * A favorite taken away from its own row's menu: that row goes, and the keyboard's place goes to the next favorite,
 * the one before, the folder under its account, or the account (Codex code review round 4 #4), unless it moved on.
 * A row still there (the request failed) gets it back (round 5 #6). Keys go through CSS.escape (round 5 #7: an IMAP
 * name may hold a quote).
 */
function keepFocusAfterUnfavorite(target: FolderTarget, before: readonly FavoriteFolder[]): void {
  const id = (f: Pick<FavoriteFolder, "accountId" | "folder" | "view">) => `nav-fav-${f.accountId}-${f.folder ?? f.view}`;
  const row = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`);
  const was = id(target);
  requestAnimationFrame(() => {
    const active = document.activeElement;
    // still in the closing menu, on the row that went, or nowhere: not moved on
    if (active && active !== document.body && active.isConnected && active.getAttribute("data-testid") !== was && !active.closest("[role=menu]")) return;
    const at = before.findIndex((f) => id(f) === was);
    const near = [was, ...[...before.slice(at + 1), ...before.slice(0, Math.max(at, 0)).reverse()].map(id)].map(row);
    const own = target.folder !== null ? `nav-own-${target.accountId}-${target.folder}` : `nav-folder-${target.accountId}-${target.view}`;
    const next = near.find(Boolean) ?? row(own) ?? row(`nav-account-${target.accountId}`);
    next?.focus({ preventScroll: false });
  });
}

/**
 * Plan 107: a folder's right-click menu (and Shift+F10, plan 106): an own folder's New subfolder…, Rename,
 * favorite, Export mailbox… and Delete folder…; a standard row's favorite and export. A favorite's row has the same.
 */
export function FolderMenu({ target, name, account, favoriteRow, children }: { target: FolderTarget; name: string; account: Account; favoriteRow?: boolean; children: ReactElement }) {
  const favorites = useApp((s) => s.settings?.favoriteFolders);
  const favorite = isFavorite(favorites, target);
  // mounted from the first Delete… on, so the dialog can animate out after
  const [deleting, setDeleting] = useState<boolean | null>(null);
  // an item that moves the focus itself (a name field, a dialog) keeps the closing menu from handing it back (plan 106)
  const [handOff, setHandOff] = useState(false);
  // plan 108 (Codex code review #2): leaving a focused account (a notification) takes this row away while its menu
  // is open: shortcuts never stay blocked behind a menu that's gone
  const open = useRef(false);
  useEffect(() => () => {
    if (open.current) setApp({ menuOpen: false });
  }, []);
  const away = (run: () => void) => () => {
    setHandOff(true);
    run();
  };
  const own = target.folder !== null;
  const id = `${target.accountId}-${target.folder ?? target.view}`;
  return (
    <>
      <ContextMenu
        onOpenChange={(next) => {
          if (next) setHandOff(false);
          open.current = next;
          setApp({ menuOpen: next });
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
            onClick={() => {
              // taken away from its own row (this menu's trigger), that row goes: the focus is handed on once it has
              // (round 5 #6: from the account's copy, or with the row still there, the menu gives it back as usual)
              const handsOn = favorite && favoriteRow === true;
              if (handsOn) setHandOff(true);
              void setFavorite(target, !favorite)
                .catch((e: unknown) => snack.error(t("folder.favoriteFailed", { error: e instanceof Error ? e.message : String(e) })))
                .finally(() => handsOn && keepFocusAfterUnfavorite(target, favorites ?? []));
            }}
          >
            <Star />
            <span className="flex-1">{favorite ? t("folder.menu.unfavorite") : t("folder.menu.favorite")}</span>
          </ContextMenuItem>
          <ContextMenuItem data-testid="folder-menu-export" onClick={() => void exportFolder(target, name)}>
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
        <FolderDeleteDialog account={account} folderKey={target.folder!} name={name} open={deleting} onOpenChange={setDeleting} />
      )}
    </>
  );
}
