import { client } from "~/rpc/connection";
import { useMemo, useRef, useState } from "react";
import { Download, Paperclip } from "@terno/ui/icons";
import type { AttachmentInfo, MessageDetail } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { IconButton } from "@terno/ui/components/icon-button";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { cn } from "@terno/ui/lib/utils";
import { attachFiles, downloadAttachment, useAttachmentUploads } from "~/lib/attachments";
import { editDraft, type LocalDraft } from "~/lib/drafts";
import { chipRefs } from "~/lib/inline-images";
import { formatBytes } from "~/lib/format";
import { retryForwardFiles, useForwardFiles, type ForwardFiles } from "~/lib/forward-files";
import { snack } from "~/lib/snack";
import { threadFiles } from "~/lib/thread-overview";

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
          }}
        >
          <span className="max-w-48 truncate">{a.filename}</span><span className="font-normal text-muted-foreground tabular">{formatBytes(a.size)}</span>
        </Chip>
      </li>)}
    </ul>}
  </div>;
}

/**
 * What a file in the reader does when chosen, the message's tile and the conversation's strip alike (plan 177): download the
 * cached bytes, or ask the backend for them while they aren't cached. One at a time per list: the rest wait.
 */
function useAttachmentOpen() {
  const [busy, setBusy] = useState<string | null>(null);
  const open = async (accountId: number, messageId: number, a: AttachmentInfo) => {
    setBusy(busyKey(a));
    try {
      if (!a.assetId) {
        try { await client.call("attachments.retry", { accountId, messageId }); snack(t("attachments.retryRequested")); }
        catch { snack.error(t("attachments.readerUnavailable")); }
        return;
      }
      try { await downloadAttachment(accountId, { ...a, assetId: a.assetId }); } catch (error) { snack.error(error instanceof Error ? error.message : t("attachments.unavailable")); }
    } finally { setBusy(null); }
  };
  return { busy, open };
}

/** one key for a file's work, a download or a retry, so aria-busy names the file it's for */
const busyKey = (a: AttachmentInfo) => a.assetId ?? `retry:${a.id}`;

/** A file's accessible name: what choosing it does, its name and size, and that it isn't on this device yet. */
const downloadLabel = (a: AttachmentInfo) => t("attachments.download", { name: `${a.filename} ${formatBytes(a.size)}${!a.assetId ? ` · ${t("attachments.notCached")}` : ""}` });

export function ReaderAttachments({ accountId, messageId, attachments }: { accountId: number; messageId: number; attachments: AttachmentInfo[] }) {
  const { busy, open } = useAttachmentOpen();
  return <ul aria-label={t("reader.attachments")} className="mt-4 flex flex-wrap gap-2">
    {attachments.map((a) => <li key={a.id} data-testid="attachment" className="min-w-0 max-w-full">
      <button type="button" aria-label={downloadLabel(a)} aria-description={a.mime} aria-busy={busy === busyKey(a)} disabled={busy !== null} className="flex h-14 w-[260px] max-w-full items-center gap-3 rounded-lg bg-tint px-3 text-left hover:bg-accent disabled:opacity-60" onClick={() => void open(accountId, messageId, a)}>
        <Paperclip className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="line-clamp-2 text-sm leading-4 font-medium break-all">{a.filename}</span>{" "}<span className="block text-xs text-muted-foreground tabular">{formatBytes(a.size)}{!a.assetId && ` · ${t("attachments.notCached")}`}</span></span><Download className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>)}
  </ul>;
}

/** past this many files, the rest wait behind "Show all": a long conversation's strip stays a few lines */
const FILES_SHOWN = 12;

/**
 * Plan 177: every file of a conversation of two or more messages, at its top (`threadFiles`), so one in a folded message is a
 * click away. A disclosure, open on each conversation shown; a file does what its message's tile does.
 */
export function ThreadAttachments({ messages }: { messages: readonly MessageDetail[] }) {
  const files = useMemo(() => (messages.length > 1 ? threadFiles(messages) : []), [messages]);
  const { busy, open } = useAttachmentOpen();
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
        <ul aria-label={t("reader.allAttachments")} className="flex flex-wrap items-center gap-1.5 pt-2">
          {shown.map(({ message, attachment: a }) => <li key={`${message.id}:${a.id}`} data-testid="thread-attachment" className="flex max-w-full min-w-0">
            <button type="button" aria-label={downloadLabel(a)} aria-description={a.mime} aria-busy={busy === busyKey(a)} disabled={busy !== null} title={a.filename} onClick={() => void open(message.accountId, message.id, a)} className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-tint px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
              <Paperclip aria-hidden className="size-[1.15em] shrink-0 text-muted-foreground" />
              <span className="max-w-56 min-w-0 truncate font-medium">{a.filename}</span>{" "}
              <span className="shrink-0 text-muted-foreground tabular">{formatBytes(a.size)}</span>
            </button>
          </li>)}
          {/* one toggle, there while open too: focus stays on it, and it folds the rest back */}
          {files.length > FILES_SHOWN && <li className="flex">
            <Button variant="link-secondary" size="xs" data-testid="thread-attachments-all" aria-expanded={all} onClick={() => setAll(!all)} className="px-1 font-normal">{all ? t("reader.showFewer") : t("reader.showAllAttachments", { count: files.length })}</Button>
          </li>}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}
