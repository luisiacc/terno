import { client } from "~/rpc/connection";
import { useRef, useState } from "react";
import { Download, Paperclip, X } from "lucide-react";
import type { AttachmentInfo } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { attachFiles, downloadAttachment, useAttachmentUploads } from "~/lib/attachments";
import { editDraft, type LocalDraft } from "~/lib/drafts";
import { formatBytes } from "~/lib/format";
import { retryForwardFiles, useForwardFiles, type ForwardFiles } from "~/lib/forward-files";
import { snack } from "~/lib/snack";

export function AttachButton({ d }: { d: LocalDraft }) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useAttachmentUploads((s) => s.keys.has(d.key));
  return <>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={t("attachments.attach")} aria-busy={busy} disabled={d.sending || busy} onClick={() => input.current?.click()}><Paperclip /></Button>
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
  if (!d.attachments?.length && !busy && !forward) return null;
  return <div className="px-3.5 py-2" aria-live="polite">
    {busy && <p role="status" className="text-xs text-muted-foreground">{t("attachments.adding")}</p>}
    {forward && <p role="status" data-testid="forward-files" data-status={forward.status} className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>{forwardFilesText(forward)}</span>
      {forward.status === "failed" && <Button type="button" variant="link" size="sm" data-testid="forward-files-retry" className="h-auto p-0 text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline" disabled={d.sending} onClick={() => retryForwardFiles(d.key)}>{t("compose.forwardFiles.tryAgain")}</Button>}
    </p>}
    {!!d.attachments?.length && <ul aria-label={t("reader.attachments")} className={cn("flex flex-wrap gap-2", forward && "mt-2")}>
      {(d.attachments ?? []).map((a) => <li key={a.assetId} data-testid="draft-attachment" className="flex max-w-full items-center gap-2 rounded-md bg-tint py-1 pl-2.5 pr-1 text-xs">
        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-48 truncate">{a.filename}</span><span className="text-muted-foreground tabular">{formatBytes(a.size)}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("attachments.remove", { name: a.filename })} disabled={d.sending || busy} onClick={(e) => {
          const body = e.currentTarget.closest("[data-testid=composer]")?.querySelector<HTMLElement>("[data-testid=compose-body]");
          editDraft(d.key, { attachments: d.attachments!.filter((x) => x.assetId !== a.assetId) });
          body?.focus({ preventScroll: true });
        }}><X className="size-3" /></Button>
      </li>)}
    </ul>}
  </div>;
}

export function ReaderAttachments({ accountId, messageId, attachments }: { accountId: number; messageId: number; attachments: AttachmentInfo[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  return <ul aria-label={t("reader.attachments")} className="mt-4 flex flex-wrap gap-2">
    {attachments.map((a) => <li key={a.id} data-testid="attachment" className="min-w-0 max-w-full">
      <button type="button" aria-label={t("attachments.download", { name: `${a.filename} ${formatBytes(a.size)}${!a.assetId ? ` · ${t("attachments.notCached")}` : ""}` })} aria-description={a.mime} aria-busy={busy === a.assetId} disabled={busy !== null} className="flex h-14 w-[260px] max-w-full items-center gap-3 rounded-lg bg-tint px-3 text-left hover:bg-accent disabled:opacity-60" onClick={async () => {
        if (!a.assetId) {
          setBusy(`retry:${a.id}`);
          try { await client.call("attachments.retry", { accountId, messageId }); snack(t("attachments.retryRequested")); }
          catch { snack.error(t("attachments.readerUnavailable")); }
          finally { setBusy(null); }
          return;
        }
        setBusy(a.assetId);
        try { await downloadAttachment(accountId, { ...a, assetId: a.assetId }); } catch (error) { snack.error(error instanceof Error ? error.message : t("attachments.unavailable")); } finally { setBusy(null); }
      }}>
        <Paperclip className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="line-clamp-2 text-sm leading-4 font-medium break-all">{a.filename}</span>{" "}<span className="block text-xs text-muted-foreground tabular">{formatBytes(a.size)}{!a.assetId && ` · ${t("attachments.notCached")}`}</span></span><Download className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>)}
  </ul>;
}
