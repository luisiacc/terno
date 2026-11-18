import { client } from "~/rpc/connection";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Download, ExternalLink, Paperclip } from "@terno/ui/icons";
import type { AttachmentInfo, MessageDetail } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { IconButton } from "@terno/ui/components/icon-button";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { cn } from "@terno/ui/lib/utils";
import { attachFiles, canOpenAttachment, downloadAttachment, openAttachment, useAttachmentUploads } from "~/lib/attachments";
import { editDraft, type LocalDraft } from "~/lib/drafts";
import { chipRefs } from "~/lib/inline-images";
import { formatBytes } from "~/lib/format";
import { retryForwardFiles, useForwardFiles, type ForwardFiles } from "~/lib/forward-files";
import { snack } from "~/lib/snack";
import { threadFiles } from "~/lib/thread-overview";
import { announce } from "~/lib/announce";
import { setApp } from "~/state/app";

export function AttachButton({ d }: { d: LocalDraft }) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useAttachmentUploads((s) => s.keys.has(d.key));
  return <>
    <IconButton label={t("attachments.attach")} aria-busy={busy} disabled={d.sending || busy} onClick={() => input.current?.click()} className="[&_svg]:[--icon-line:var(--icon-line-toolbar)]"><Paperclip /></IconButton>
    <input ref={input} type="file" multiple hidden data-testid="attachment-input" aria-label={t("attachments.attach")} disabled={d.sending || busy} onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; void attachFiles(d.key, files); }} />
  </>;
}

/** What a forward's draft says about its original's files that haven't joined it (plan 60). */
function forwardFilesText(state: ForwardFiles): string {
  switch (state.status) {
    case "fetching": return state.names.length ? t("compose.forwardFiles.fetching", { names: formatList(state.names) }) : t("compose.forwardFiles.fetchingUnknown");
    case "failed": return state.names.length ? t("compose.forwardFiles.failed", { count: state.names.length, names: formatList(state.names) }) : t("compose.forwardFiles.failedUnknown");
    case "tooLarge": return t("attachments.tooLarge");
    case "account": return t("compose.forwardFiles.account", { account: state.account });
  }
}

export function DraftAttachments({ d }: { d: LocalDraft }) {
  const busy = useAttachmentUploads((s) => s.keys.has(d.key));
  const forward = useForwardFiles((s) => s[d.key]);
  // plan 76: an image placed in the text is shown there, not as a chip
  const chips = chipRefs(d.attachments ?? [], d.bodyHtml);
  if (!chips.length && !busy && !forward) return null;
  return <div className="px-3.5 py-2" aria-live="polite">
    {busy && <p role="status" className="text-xs text-muted-foreground">{t("attachments.adding")}</p>}
    {forward && <p role="status" data-testid="forward-files" data-status={forward.status} className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>{forwardFilesText(forward)}</span>
      {forward.status === "failed" && <Button variant="link-secondary" data-testid="forward-files-retry" className="text-xs" disabled={d.sending} onClick={() => retryForwardFiles(d.key)}>{t("compose.forwardFiles.tryAgain")}</Button>}
    </p>}
    {!!chips.length && <ul aria-label={t("reader.attachments")} className={cn("flex flex-wrap gap-2", forward && "mt-2")}>
      {chips.map((a) => <li key={a.assetId} data-testid="draft-attachment" className="flex max-w-full">
        <Chip
          dot={<Paperclip className="size-3.5 shrink-0 text-muted-foreground" />}
          removeLabel={t("attachments.remove", { name: a.filename })}
          removeProps={{ disabled: d.sending || busy }}
          onRemove={(e) => {
            const body = e.currentTarget.closest("[data-testid=composer]")?.querySelector<HTMLElement>("[data-testid=compose-body]");
            editDraft(d.key, { attachments: d.attachments!.filter((x) => x.assetId !== a.assetId) });
            body?.focus({ preventScroll: true });
            // plan 188: focus went to the text; what happened is said
            announce(t("attachments.removed", { name: a.filename }));
          }}
        >
          <span className="max-w-48 truncate">{a.filename}</span><span className="font-normal text-muted-foreground tabular">{formatBytes(a.size)}</span>
        </Chip>
      </li>)}
    </ul>}
  </div>;
}

/** a file in the reader, and where it's from */
type FileTarget = { accountId: number; messageId: number; a: AttachmentInfo };
type FileAction = "open" | "download";

/** one key for a file's work (an open, a download or a retry), so aria-busy names the file it's for */
const busyKey = (a: AttachmentInfo) => a.assetId ?? `retry:${a.id}`;

/** what choosing a file does (plan 212): open what opens here, download the rest */
const clickAction = (a: AttachmentInfo): FileAction => (canOpenAttachment(a.filename) ? "open" : "download");

/**
 * Opens or downloads a file, or asks the backend for its bytes while they aren't on this device. Called straight from
 * the click or the menu item: the web build reserves its tab before anything is awaited (`openAttachment`).
 */
function runFileAction({ accountId, messageId, a }: FileTarget, how: FileAction): Promise<void> {
  if (!a.assetId) return client.call("attachments.retry", { accountId, messageId }).then(() => { snack(t("attachments.retryRequested")); }, () => { snack.error(t("attachments.readerUnavailable")); });
  const ref = { ...a, assetId: a.assetId };
  const work: Promise<unknown> = how === "open" ? openAttachment(accountId, ref) : downloadAttachment(accountId, ref);
  return work.then(() => {}, (error: unknown) => { snack.error(error instanceof Error ? error.message : t("attachments.unavailable")); });
}

/**
 * What a file in the reader does when chosen, the message's tile and the conversation's strip alike (plan 177). One at
 * a time per list: the rest say they're unavailable meanwhile, but stay focusable, so a menu or a keypress never hands
 * focus to a disabled button (plan 212).
 */
function useFileActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const act = (f: FileTarget, how: FileAction) => {
    if (running.current) return;
    running.current = true;
    setBusy(busyKey(f.a));
    void runFileAction(f, how).finally(() => { running.current = false; setBusy(null); });
  };
  /** a file's button: named for what a click does, and marked so its list's menu finds it */
  const fileProps = (f: FileTarget) => {
    const how = clickAction(f.a);
    return {
      type: "button" as const,
      "data-attachment": fileKey(f),
      "aria-label": fileLabel(f.a, how),
      "aria-description": f.a.mime,
      "aria-busy": busy === busyKey(f.a),
      "aria-disabled": busy !== null || undefined,
      onClick: () => act(f, how),
    };
  };
  return { act, fileProps };
}

const fileKey = (f: FileTarget) => `${f.messageId}:${f.a.id}`;

/** A file's accessible name: what choosing it does, its name and size, and that it isn't on this device yet. */
const fileLabel = (a: AttachmentInfo, how: FileAction) => t(how === "open" ? "attachments.open" : "attachments.download", { name: `${a.filename} ${formatBytes(a.size)}${!a.assetId ? ` · ${t("attachments.notCached")}` : ""}` });

/**
 * Plan 212: a list of files' right-click menu, one for the whole list: Open (when the file opens here) and Download. A
 * right-click (or ⇧F10, `data-context-menu`) on a file opens it there and not the conversation's; one between files is
 * passed on to the conversation's. Focus goes back to the file it was opened on.
 */
function FilesMenu({ files, act, children }: { files: readonly FileTarget[]; act: (f: FileTarget, how: FileAction) => void; children: ReactElement }) {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const button = useRef<HTMLElement | null>(null);
  // shortcuts wait while a menu is open; a list that goes while its menu is open never leaves them waiting
  const shown = useRef(false);
  useEffect(() => () => {
    if (shown.current) setApp({ menuOpen: false });
  }, []);
  return (
    <ContextMenu
      onOpenChange={(next) => {
        shown.current = next;
        setApp({ menuOpen: next });
      }}
    >
      <ContextMenuTrigger
        data-context-menu
        render={children}
        onContextMenu={(e) => {
          const el = (e.target as Element).closest<HTMLElement>("[data-attachment]");
          const found = el ? files.find((f) => fileKey(f) === el.dataset.attachment) : undefined;
          if (!el || !found) {
            // between files: the conversation's menu. Skipping Base UI marks this event for every trigger it reaches,
            // so it goes on as a fresh one from the list's parent (as message-menu's backgroundMenu replays one)
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.parentElement?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
            return;
          }
          // this menu, not the conversation's around it
          e.stopPropagation();
          button.current = el;
          setTarget(found);
        }}
      />
      <ContextMenuContent className="w-auto min-w-40 max-w-72" data-testid="attachment-menu" aria-label={target?.a.filename} finalFocus={() => (button.current?.isConnected ? button.current : true)}>
        {target && clickAction(target.a) === "open" && (
          <ContextMenuItem data-testid="attachment-menu-open" onClick={() => act(target, "open")}>
            <ExternalLink />
            <span className="flex-1">{t("common.open")}</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem data-testid="attachment-menu-download" onClick={() => target && act(target, "download")}>
          <Download />
          <span className="flex-1">{t("attachments.downloadItem")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ReaderAttachments({ accountId, messageId, attachments }: { accountId: number; messageId: number; attachments: AttachmentInfo[] }) {
  const { act, fileProps } = useFileActions();
  const files = attachments.map((a) => ({ accountId, messageId, a }));
  return <FilesMenu files={files} act={act}>
    <ul aria-label={t("reader.attachments")} className="mt-4 flex flex-wrap gap-2">
      {files.map((f) => <li key={f.a.id} data-testid="attachment" className="min-w-0 max-w-full">
        <button {...fileProps(f)} className="flex h-14 w-[260px] max-w-full items-center gap-3 rounded-lg bg-tint px-3 text-left hover:bg-accent aria-disabled:opacity-60">
          <Paperclip className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="line-clamp-2 text-sm leading-4 font-medium break-all">{f.a.filename}</span>{" "}<span className="block text-xs text-muted-foreground tabular">{formatBytes(f.a.size)}{!f.a.assetId && ` · ${t("attachments.notCached")}`}</span></span>
          {/* what a click does when it isn't the obvious open: a file that opens shows none, as Mail's tiles */}
          {clickAction(f.a) === "download" && <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
      </li>)}
    </ul>
  </FilesMenu>;
}

/** past this many files, the rest wait behind "Show all": a long conversation's strip stays a few lines */
const FILES_SHOWN = 12;

/**
 * Plan 177: every file of a conversation of two or more messages, at its top (`threadFiles`), so one in a folded message is a
 * click away. A disclosure, open on each conversation shown; a file does what its message's tile does.
 */
export function ThreadAttachments({ messages }: { messages: readonly MessageDetail[] }) {
  const files = useMemo(() => (messages.length > 1 ? threadFiles(messages).map(({ message, attachment }) => ({ accountId: message.accountId, messageId: message.id, a: attachment })) : []), [messages]);
  const { act, fileProps } = useFileActions();
  const [all, setAll] = useState(false);
  if (!files.length) return null;
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    // 20 px above, whatever is there: its margin and the header's (12) or a card's (16) collapse into one gap
    <Collapsible defaultOpen data-testid="thread-attachments" className="mt-5 mb-4">
      <CollapsibleTrigger className="w-auto gap-1.5 rounded-sm text-xs font-medium text-foreground-soft hover:text-foreground [&_[data-slot=collapsible-chevron]]:ms-0 [&_[data-slot=collapsible-chevron]]:size-3.5">
        {t("reader.attachments")}<span className="font-normal text-muted-foreground tabular">{files.length}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <FilesMenu files={shown} act={act}>
        <ul aria-label={t("reader.allAttachments")} className="flex flex-wrap items-center gap-1.5 pt-2">
          {shown.map((f) => <li key={fileKey(f)} data-testid="thread-attachment" className="flex max-w-full min-w-0">
            <button {...fileProps(f)} title={f.a.filename} className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-tint px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60">
              <Paperclip aria-hidden className="size-[1.15em] shrink-0 text-muted-foreground" />
              <span className="max-w-56 min-w-0 truncate font-medium">{f.a.filename}</span>{" "}
              <span className="shrink-0 text-muted-foreground tabular">{formatBytes(f.a.size)}</span>
            </button>
          </li>)}
          {/* one toggle, there while open too: focus stays on it, and it folds the rest back */}
          {files.length > FILES_SHOWN && <li className="flex">
            <Button variant="link-secondary" size="xs" data-testid="thread-attachments-all" aria-expanded={all} onClick={() => setAll(!all)} className="px-1 font-normal">{all ? t("reader.showFewer") : t("reader.showAllAttachments", { count: files.length })}</Button>
          </li>}
        </ul>
        </FilesMenu>
      </CollapsiblePanel>
    </Collapsible>
  );
}
