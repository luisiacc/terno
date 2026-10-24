import type { DraftMode } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Shortcut } from "@unica/ui/components/shortcut";
import { Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { sendDraft } from "~/lib/compose";
import { discardDraft, editDraft, flushDraft, restoreDiscarded, useDrafts, type DraftFields } from "~/lib/drafts";
import { setApp, useApp } from "~/state/app";

const TITLE: Record<DraftMode, string> = { new: "Nuevo mensaje", reply: "Responder", replyAll: "Responder a todos", forward: "Reenviar" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 border-b border-border px-4">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const fieldClass = "h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground";

/** Closing keeps the draft: what is written is saved first. */
function close(key: string) {
  void flushDraft(key);
  setApp({ compose: null });
}

export function Composer() {
  const compose = useApp((s) => s.compose);
  const d = useDrafts((s) => (compose ? s.drafts[compose.key] : undefined));
  const accounts = useApp((s) => s.accounts);
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!compose || !d) return;
    setShowCc(Boolean(d.ccText));
    requestAnimationFrame(() => {
      const el = d.mode === "new" || d.mode === "forward" ? document.querySelector<HTMLInputElement>("[data-testid=compose-to]") : bodyRef.current;
      el?.focus();
      if (el instanceof HTMLTextAreaElement) el.setSelectionRange(0, 0);
    });
  }, [compose?.seq]);

  // replies are written inline in their conversation; this floating composer only writes new messages
  if (!compose || !d || d.mode !== "new") return null;
  const key = compose.key;
  const update = (patch: Partial<DraftFields>) => editDraft(key, patch);
  const send = async () => {
    if (sending) return;
    setSending(true);
    await sendDraft(key);
    setSending(false);
  };
  const discard = async () => {
    setApp({ compose: null });
    const gone = await discardDraft(key);
    if (gone) toast("Borrador descartado", { action: { label: "Deshacer", onClick: () => setApp({ compose: { key: restoreDiscarded(gone), seq: Date.now() } }) } });
  };

  return (
    <div
      data-testid="composer"
      role="dialog"
      aria-label={TITLE[d.mode]}
      className="absolute right-6 bottom-6 z-40 flex max-h-[min(640px,calc(100%-3rem))] w-[min(600px,calc(100%-3rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl ring-1 ring-foreground/5 animate-in fade-in-0 slide-in-from-bottom-2 duration-slow"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close(key);
        }
      }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-4">
        <span className="text-sm font-medium">{TITLE[d.mode]}</span>
        <button type="button" aria-label="Cerrar" onClick={() => close(key)} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <Field label="De">
        <Select value={String(d.accountId)} onValueChange={(v) => update({ accountId: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: `${a.displayName} · ${a.email}` }))}>
          <SelectTrigger size="sm" className="-ml-2 h-8 border-0 bg-transparent shadow-none dark:bg-transparent" data-testid="compose-from">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.displayName} · {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Para">
        <input data-testid="compose-to" className={fieldClass} value={d.toText} onChange={(e) => update({ toText: e.target.value })} placeholder="nombre@ejemplo.com" />
        {!showCc && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCc(true)}>
            Cc
          </button>
        )}
      </Field>
      {showCc && (
        <Field label="Cc">
          <input data-testid="compose-cc" className={fieldClass} value={d.ccText} onChange={(e) => update({ ccText: e.target.value })} />
        </Field>
      )}
      <Field label="Asunto">
        <input data-testid="compose-subject" className={fieldClass} value={d.subject} onChange={(e) => update({ subject: e.target.value, subjectEdited: true })} />
      </Field>
      <textarea
        ref={bodyRef}
        data-testid="compose-body"
        value={d.bodyText}
        onChange={(e) => update({ bodyText: e.target.value })}
        className="min-h-56 flex-1 resize-none bg-transparent px-4 py-3 text-base leading-relaxed outline-none"
        placeholder="Escribe tu mensaje…"
      />
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
        <Button data-testid="compose-send" onClick={send} disabled={sending} className="gap-2" aria-busy={sending}>
          <Send /> Enviar <Shortcut keys="mod+enter" className="[&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
        </Button>
        <span className="text-2xs text-muted-foreground">{d.status === "saved" ? "Borrador guardado" : d.status === "error" ? "No se pudo guardar" : ""}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" aria-label="Descartar" onClick={discard}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
