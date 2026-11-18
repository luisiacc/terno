import { client } from "~/rpc/connection";
import { useEffect, useMemo, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { Download, ExternalLink, Paperclip } from "@terno/ui/icons";
import type { AttachmentInfo, MessageDetail } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { IconButton } from "@terno/ui/components/icon-button";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { cn } from "@terno/ui/lib/utils";
import { AttachmentOpenFailed, attachFiles, canOpenAttachment, downloadAttachment, openAttachment, useAttachmentUploads } from "~/lib/attachments";
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
function runFileAction({ accountId, messageId, a }: FileTarget, how: FileAction, download: () => void): Promise<void> {
  if (!a.assetId) return client.call("attachments.retry", { accountId, messageId }).then(() => { snack(t("attachments.retryRequested")); }, () => { snack.error(t("attachments.readerUnavailable")); });
  const ref = { ...a, assetId: a.assetId };
  const work: Promise<unknown> = how === "open" ? openAttachment(accountId, ref) : downloadAttachment(accountId, ref);
  return work.then(() => {}, (error: unknown) => {
    // a file that couldn't open can still be saved: the way to it is on what says so, not in a menu to find
    const action = error instanceof AttachmentOpenFailed ? { label: t("attachments.downloadItem"), name: t("attachments.download", { name: a.filename }), onClick: download } : undefined;
    snack.error(error instanceof Error ? error.message : t("attachments.unavailable"), { action });
  });
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
    // the snack's Download is asked for on its own: it never waits on the list's one-at-a-time, which would drop it while
    // another file's work runs (Codex code review)
    void runFileAction(f, how, () => void runFileAction(f, "download", () => {})).finally(() => { running.current = false; setBusy(null); });
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
  /**
   * Plan 212: the Download button a file that opens shows at its right on hover (or its own Tab focus); a file whose click
   * downloads shows the glyph there instead, not a second control doing the same thing. Marked like the file, so a
   * right-click on it opens the file's menu.
   */
  const downloadButton = (f: FileTarget, size: "icon-xs" | "icon-sm", className: string) =>
    clickAction(f.a) === "open"
      ? <IconButton label={t("attachments.download", { name: f.a.filename })} size={size} data-attachment={fileKey(f)} data-testid="attachment-download" aria-disabled={busy !== null || undefined} className={className} onClick={() => act(f, "download")}><Download /></IconButton>
      : <span aria-hidden className={cn("pointer-events-none flex items-center justify-center text-muted-foreground", size === "icon-xs" ? "size-6" : "size-7")}><Download className={size === "icon-xs" ? "size-[1.15em]" : "size-3.5"} /></span>;
  return { busy: busy !== null, act, fileProps, downloadButton };
}

const fileKey = (f: FileTarget) => `${f.messageId}:${f.a.id}`;

/** A file's accessible name: what choosing it does, its name and size, and that it isn't on this device yet. */
const fileLabel = (a: AttachmentInfo, how: FileAction) => t(how === "open" ? "attachments.open" : "attachments.download", { name: `${a.filename} ${formatBytes(a.size)}${!a.assetId ? ` · ${t("attachments.notCached")}` : ""}` });

/**
 * Plan 212: a list of files' right-click menu, one for the whole list: Open (when the file opens here) and Download. A
 * right-click (or ⇧F10, `data-context-menu`) on a file opens it there and not the conversation's; one between files is
 * passed on to the conversation's. Focus goes back to the file it was opened on.
 */
function FilesMenu({ files, busy, act, children }: { files: readonly FileTarget[]; busy: boolean; act: (f: FileTarget, how: FileAction) => void; children: ReactElement }) {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const button = useRef<HTMLElement | null>(null);
  // shortcuts wait while a menu is open; a list that goes while its menu is open never leaves them waiting
  const shown = useRef(false);
  useEffect(() => () => {
    if (shown.current) setApp({ menuOpen: false });
  }, []);
  /** the file under the pointer or finger, remembered for the menu; null between files */
  const pick = (from: EventTarget): FileTarget | null => {
    const el = (from as Element).closest<HTMLElement>("[data-attachment]");
    const found = el ? files.find((f) => fileKey(f) === el.dataset.attachment) : undefined;
    if (!el || !found) return null;
    button.current = el;
    setTarget(found);
    return found;
  };
  const skipBaseUI = (e: SyntheticEvent) => (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
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
          if (pick(e.target)) return;
          // between files: the conversation's menu. Skipping Base UI marks this event for every trigger it reaches,
          // so it goes on as a fresh one from the list's parent (as message-menu's backgroundMenu replays one)
          skipBaseUI(e);
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.parentElement?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
        }}
        // a long press opens the menu without a contextmenu event: the file is picked here too, and one between files is
        // left to the conversation's own long press
        onTouchStart={(e) => {
          if (e.touches.length === 1 && !pick(e.target)) skipBaseUI(e);
        }}
      />
      <ContextMenuContent className="w-auto min-w-40 max-w-72" data-testid="attachment-menu" aria-label={target?.a.filename} finalFocus={() => (button.current?.isConnected ? button.current : true)}>
        {/* while a file's work runs the list takes no other: its items say so, as the files do */}
        {target && clickAction(target.a) === "open" && (
          <ContextMenuItem data-testid="attachment-menu-open" disabled={busy} onClick={() => act(target, "open")}>
            <ExternalLink />
            <span className="flex-1">{t("common.open")}</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem data-testid="attachment-menu-download" disabled={busy} onClick={() => target && act(target, "download")}>
          <Download />
          <span className="flex-1">{t("attachments.downloadItem")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ReaderAttachments({ accountId, messageId, attachments }: { accountId: number; messageId: number; attachments: AttachmentInfo[] }) {
  const { busy, act, fileProps, downloadButton } = useFileActions();
  const files = attachments.map((a) => ({ accountId, messageId, a }));
  return <FilesMenu files={files} busy={busy} act={act}>
    <ul aria-label={t("reader.attachments")} className="mt-4 flex flex-wrap gap-2">
      {/* the tile is the item, so its hover holds while the pointer is on its Download button */}
      {files.map((f) => <li key={f.a.id} data-testid="attachment" className="group/file relative min-w-0 max-w-full rounded-lg bg-tint hover:bg-accent has-[[aria-disabled=true]]:opacity-60">
        <button {...fileProps(f)} className="flex h-14 w-[260px] max-w-full items-center gap-3 rounded-lg ps-3 pe-11 text-left">
          <Paperclip className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="line-clamp-2 text-sm leading-4 font-medium break-all">{f.a.filename}</span>{" "}<span className="block text-xs text-muted-foreground tabular">{formatBytes(f.a.size)}{!f.a.assetId && ` · ${t("attachments.notCached")}`}</span></span>
        </button>
        {/* the slot the text leaves free (pe-11): the glyph at rest where a click downloads, the button on hover where it opens */}
        <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center">
          {downloadButton(f, "icon-sm", cn(SHOWN_ON_HOVER, ARRIVES, "transition-[opacity,scale,background-color,color] opacity-0 scale-90 group-hover/file:opacity-100 group-hover/file:scale-100 focus-reveal:opacity-100 focus-reveal:scale-100"))}
        </span>
      </li>)}
    </ul>
  </FilesMenu>;
}

/**
 * A file's Download button takes the pointer only while it shows: hidden, a click or a tap at the file's end reaches the
 * file (a touch screen never hovers, so there it's never in the way). Tab still reaches it, and shows it.
 */
const SHOWN_ON_HOVER = "pointer-events-none group-hover/file:pointer-events-auto focus-reveal:pointer-events-auto";

/**
 * How it arrives: a fade and a grow from nine tenths, eased out over the motion cap (--motion-slow); it leaves in half that,
 * so moving on never waits on it. Motion off or reduced: it simply appears (globals.css).
 */
const ARRIVES = "duration-fast ease-motion group-hover/file:duration-slow focus-reveal:duration-slow";

/** past this many files, the rest wait behind "Show all": a long conversation's strip stays a few lines */
const FILES_SHOWN = 12;

/**
 * Plan 177: every file of a conversation of two or more messages, at its top (`threadFiles`), so one in a folded message is a
 * click away. A disclosure, open on each conversation shown; a file does what its message's tile does.
 */
export function ThreadAttachments({ messages }: { messages: readonly MessageDetail[] }) {
  const files = useMemo(() => (messages.length > 1 ? threadFiles(messages).map(({ message, attachment }) => ({ accountId: message.accountId, messageId: message.id, a: attachment })) : []), [messages]);
  const { busy, act, fileProps, downloadButton } = useFileActions();
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
        <FilesMenu files={shown} busy={busy} act={act}>
        <ul aria-label={t("reader.allAttachments")} className="flex flex-wrap items-center gap-1.5 pt-2">
          {shown.map((f) => <li key={fileKey(f)} data-testid="thread-attachment" className="group/file relative flex max-w-full min-w-0 rounded-md bg-tint hover:bg-accent has-[[aria-disabled=true]]:opacity-60">
            <button {...fileProps(f)} title={f.a.filename} className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Paperclip aria-hidden className="size-[1.15em] shrink-0 text-muted-foreground" />
              <span className="max-w-56 min-w-0 truncate font-medium">{f.a.filename}</span>{" "}
              {/* a chip has no room to spare: its size steps aside for the Download button, no letter cut and nothing moving */}
              <span className="shrink-0 text-muted-foreground tabular transition-opacity duration-fast ease-motion group-hover/file:opacity-0 group-hover/file:duration-slow group-has-[[data-testid=attachment-download]:focus-visible]/file:opacity-0">{formatBytes(f.a.size)}</span>
            </button>
            <span className="pointer-events-none absolute inset-y-0 end-0.5 flex items-center opacity-0 transition-opacity duration-fast ease-motion group-hover/file:opacity-100 group-hover/file:duration-slow has-[:focus-visible]:opacity-100 has-[:focus-visible]:duration-slow">
              {downloadButton(f, "icon-xs", cn(SHOWN_ON_HOVER, ARRIVES, "transition-[scale,background-color,color] scale-90 group-hover/file:scale-100 focus-reveal:scale-100"))}
            </span>
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
