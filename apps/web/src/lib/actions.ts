import { formatAddressList, isValidEmail, parseAddressList, type ThreadAction, type ThreadSummary, type View } from "@unica/core";
import { toast } from "sonner";
import { reflowRemoval } from "~/lib/flash";
import { client } from "~/rpc/connection";
import { getApp, setApp, type ComposeDraft } from "~/state/app";
import { patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";

/** Does a thread still belong in the current view after an action? */
function staysInView(view: View, action: ThreadAction): boolean {
  switch (action) {
    case "archive":
      return view === "all" || view === "archive" || view === "sent" || view === "starred";
    case "trash":
      return view === "trash";
    case "spam":
      return view === "spam";
    case "notSpam":
      return view !== "spam";
    case "moveToInbox":
      return view !== "trash" && view !== "spam" && view !== "archive";
    case "unstar":
      return view !== "starred";
    default:
      return true;
  }
}

const LABEL: Partial<Record<ThreadAction, [string, ThreadAction]>> = {
  archive: ["Archivado", "moveToInbox"],
  trash: ["Movido a la papelera", "moveToInbox"],
  spam: ["Marcado como spam", "notSpam"],
};

/**
 * Applies a triage action optimistically: the list updates in the same frame,
 * selection advances to the next thread, and the backend persists + syncs.
 */
export async function act(action: ThreadAction, ids?: number[]): Promise<void> {
  const s = getApp();
  const targets = ids ?? (s.checked.size ? [...s.checked] : s.selectedId !== null ? [s.selectedId] : []);
  if (targets.length === 0) return;
  const { items, index } = useList.getState();
  const leaving = s.query ? false : !staysInView(s.view, action);

  if (leaving && s.selectedId !== null && targets.includes(s.selectedId)) {
    // Superhuman-style: move to the next thread that isn't being removed
    const start = index.get(s.selectedId) ?? 0;
    const removed = new Set(targets);
    const next = items.slice(start + 1).find((t) => !removed.has(t.id)) ?? items.slice(0, start).reverse().find((t) => !removed.has(t.id));
    setApp({ selectedId: next?.id ?? null });
  }
  if (leaving) reflowRemoval(targets);
  patchRows(targets, (t): ThreadSummary | null => {
    if (leaving) return null;
    switch (action) {
      case "markRead":
        return { ...t, unread: false };
      case "markUnread":
        return { ...t, unread: true };
      case "star":
        return { ...t, starred: true };
      case "unstar":
        return { ...t, starred: false };
      default:
        return t;
    }
  });
  if (s.checked.size) setApp({ checked: new Set() });
  try {
    await client.call("threads.act", { threadIds: targets, action });
    invalidateThreads(targets);
    const label = LABEL[action];
    if (label) {
      toast(targets.length > 1 ? `${label[0]} · ${targets.length} conversaciones` : label[0], {
        action: { label: "Deshacer", onClick: () => void act(label[1], targets).then(() => reloadList({ keepSelection: true })) },
      });
    }
  } catch (error) {
    toast.error(`No se pudo completar: ${error instanceof Error ? error.message : error}`);
    void reloadList({ keepSelection: true });
  }
}

export function toggleStar(): void {
  const s = getApp();
  const row = s.selectedId !== null ? useList.getState().items[useList.getState().index.get(s.selectedId) ?? -1] : undefined;
  void act(row?.starred ? "unstar" : "star");
}

let readTimer: ReturnType<typeof setTimeout> | null = null;
/** Opening a thread marks it read after a short dwell, so holding j doesn't mark everything read. */
export function scheduleMarkRead(id: number): void {
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const st = useList.getState();
    const row = st.items[st.index.get(id) ?? -1];
    if (row?.unread && getApp().selectedId === id) void act("markRead", [id]);
  }, 450);
}

// ───────────────────────────── compose ─────────────────────────────

// Structured formatting/parsing (quoted display names) so a crafted sender name can't add recipients.
const formatList = formatAddressList;
export const parseAddresses = parseAddressList;

let composeKey = 0;
export function openCompose(mode: ComposeDraft["mode"] = "new"): void {
  const s = getApp();
  const defaultAccount = s.accountId ?? s.accounts[0]?.id;
  if (!defaultAccount) {
    toast("Conecta una cuenta para escribir correos");
    setApp({ dialog: "addAccount" });
    return;
  }
  if (mode === "new" || s.selectedId === null) {
    setApp({ compose: { key: ++composeKey, mode: "new", accountId: defaultAccount, to: "", cc: "", subject: "", body: "" } });
    return;
  }
  void loadThread(s.selectedId).then((detail) => {
    if (!detail) return;
    const last = [...detail.messages].reverse().find((m) => !m.isSent) ?? detail.messages[detail.messages.length - 1]!;
    const account = s.accounts.find((a) => a.id === detail.thread.accountId) ?? s.accounts[0]!;
    const me = account.email.toLowerCase();
    const date = new Date(last.date).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
    const quoted = (last.bodyText ?? last.snippet).split("\n").map((l) => `> ${l}`).join("\n");
    const subj = detail.thread.subject;
    if (mode === "forward") {
      setApp({
        compose: {
          key: ++composeKey,
          mode,
          accountId: account.id,
          to: "",
          cc: "",
          subject: /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`,
          body: `\n\n---------- Mensaje reenviado ----------\nDe: ${formatList([last.from])}\nFecha: ${date}\nAsunto: ${last.subject}\nPara: ${formatList(last.to)}\n\n${last.bodyText ?? last.snippet}`,
          forwardOfMessageId: last.id,
          threadId: detail.thread.id,
        },
      });
      return;
    }
    const to = last.isSent ? last.to : [last.from];
    const cc = mode === "replyAll" ? [...last.to, ...last.cc].filter((a) => a.email.toLowerCase() !== me && !to.some((t) => t.email === a.email)) : [];
    setApp({
      compose: {
        key: ++composeKey,
        mode,
        accountId: account.id,
        to: formatList(to),
        cc: formatList(cc),
        subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
        body: `\n\nEl ${date}, ${last.from.name || last.from.email} escribió:\n${quoted}`,
        inReplyToMessageId: last.id,
        threadId: detail.thread.id,
      },
    });
  });
}

export async function sendCompose(draft: ComposeDraft): Promise<boolean> {
  const to = parseAddresses(draft.to);
  if (to.length === 0 || [...to, ...parseAddresses(draft.cc)].some((a) => !isValidEmail(a.email))) {
    toast.error("Revisa los destinatarios");
    return false;
  }
  try {
    const res = await client.call("compose.send", {
      accountId: draft.accountId,
      to,
      cc: parseAddresses(draft.cc),
      subject: draft.subject,
      bodyText: draft.body,
      inReplyToMessageId: draft.inReplyToMessageId,
      forwardOfMessageId: draft.forwardOfMessageId,
      draftId: draft.draftId,
    });
    setApp({ compose: null });
    invalidateThreads([res.threadId]);
    toast.success("Enviando…");
    return true;
  } catch (error) {
    toast.error(`No se pudo enviar: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
