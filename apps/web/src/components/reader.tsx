import type { CategoryColor, MessageDetail } from "@unica/core";
import { Button } from "@unica/ui/components/button";
import { CategoryBadge, CategoryDot } from "@unica/ui/components/category-dot";
import { Shortcut } from "@unica/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@unica/ui/components/tooltip";
import { cn } from "@unica/ui/lib/utils";
import { Archive, Forward, Inbox, MailOpen, OctagonAlert, Paperclip, Reply, ReplyAll, Star, Tag, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { act, cancelMarkRead, openCompose, scheduleMarkRead, toggleStar } from "~/lib/actions";
import { acceptSuggestion, rejectSuggestion, removeFromCategory } from "~/lib/categorize";
import { avatarColor, formatBytes, fullDate, initials, listDate } from "~/lib/format";
import { setApp, useApp } from "~/state/app";
import { loadThread, useThread } from "~/state/threads";
import { HtmlBody, TextBody } from "./mail-body";

const AVATAR_BG: Record<string, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  indigo: "bg-cat-indigo/15 text-cat-indigo-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
};

function ToolButton({ label, keys, onClick, children, testId, active }: { label: string; keys?: string; onClick: () => void; children: React.ReactNode; testId?: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={label} data-testid={testId} onClick={onClick} className={cn("no-drag text-muted-foreground hover:text-foreground", active && "text-star hover:text-star")}>
            {children}
          </Button>
        }
      />
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
  );
}

/** Why the engine did or suggests something: its reasons, in plain words. */
function Reasons({ title, reasons, hint }: { title: string; reasons: string[]; hint?: string }) {
  return (
    <TooltipContent className="max-w-72 flex-col items-start gap-1 text-left" data-testid="category-reasons">
      <p className="font-medium">{title}</p>
      {reasons.length > 0 && <p className="opacity-80">{reasons.join(" · ")}</p>}
      {hint && <p className="opacity-60">{hint}</p>}
    </TooltipContent>
  );
}

function Message({ m, expanded, onToggle }: { m: MessageDetail; expanded: boolean; onToggle: () => void }) {
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? "ask");
  const localMode = useApp((s) => s.settings?.localMode ?? true);
  const mailAppearance = useApp((s) => s.settings?.htmlMailAppearance ?? "auto");
  const color = avatarColor(m.from.email);
  return (
    <article data-testid="message" className={cn("rounded-xl border border-border bg-card", !expanded && "cursor-pointer hover:bg-row-hover")} onClick={!expanded ? onToggle : undefined}>
      <header className={cn("flex items-start gap-3 px-4 pt-3.5", expanded ? "pb-2" : "pb-3.5")} onClick={expanded ? onToggle : undefined}>
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold", AVATAR_BG[color])}>{initials(m.from.name || m.from.email)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{m.from.name || m.from.email}</span>
            {expanded && <span className="truncate text-xs text-muted-foreground">{m.from.email}</span>}
            <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground tabular" title={fullDate(m.date)}>
              {listDate(m.date)}
            </span>
          </div>
          {expanded ? (
            <p className="truncate text-xs text-muted-foreground">
              para {m.to.map((a) => a.name || a.email).join(", ")}
              {m.cc.length > 0 && ` · cc ${m.cc.map((a) => a.name || a.email).join(", ")}`}
            </p>
          ) : (
            <p className="truncate text-sm text-muted-foreground">{m.snippet}</p>
          )}
        </div>
      </header>
      {expanded && (
        <div className="px-4 pb-4 pl-15">
          {m.bodyHtml ? (
            <HtmlBody html={m.bodyHtml} remoteImages={remoteImages} localMode={localMode} appearance={mailAppearance} />
          ) : m.bodyText !== null ? (
            <TextBody text={m.bodyText} />
          ) : (
            <p className="text-sm text-muted-foreground italic">Descargando el contenido…</p>
          )}
          {m.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs">
                  <Paperclip className="size-3 text-muted-foreground" />
                  {a.filename}
                  <span className="text-muted-foreground">{formatBytes(a.size)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Welcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-10 text-center" data-testid="reader-empty">
      <div>
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary text-xl font-semibold text-primary-foreground shadow-sm">Ú</div>
        <p className="text-lg font-semibold tracking-tight">Única</p>
        <p className="mt-1 text-sm text-muted-foreground">El único cliente de email que necesitas</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-muted-foreground">
        {[
          ["j k", "Moverse"],
          ["e", "Archivar"],
          ["/", "Buscar"],
          ["mod+k", "Comandos"],
          ["c", "Escribir"],
          ["?", "Atajos"],
        ].map(([k, l]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <span>{l}</span>
            <Shortcut keys={k!} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Reader() {
  const selectedId = useApp((s) => s.selectedId);
  const detail = useThread(selectedId);
  const categories = useApp((s) => s.categories);
  const accounts = useApp((s) => s.accounts);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (selectedId === null) return;
    // the header renders from the cached row immediately; the body follows (debounced while holding j)
    const t = setTimeout(() => void loadThread(selectedId), detail ? 0 : 40);
    scheduleMarkRead(selectedId);
    return () => clearTimeout(t);
  }, [selectedId]);

  // a dwell only counts while the reader shows the thread
  useEffect(() => cancelMarkRead, []);

  useEffect(() => {
    if (!detail) return;
    // expand unread messages and the last one
    const open = new Set(detail.messages.filter((m) => !m.isRead).map((m) => m.id));
    const last = detail.messages[detail.messages.length - 1];
    if (last) open.add(last.id);
    setExpanded(open);
  }, [detail?.thread.id, detail?.messages.length]);

  if (selectedId === null) return <Welcome />;
  const t = detail?.thread;
  const cats = t ? categories.filter((c) => t.categoryIds.includes(c.id)) : [];
  const account = t ? accounts.find((a) => a.id === t.accountId) : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="reader">
      <div className="drag-region flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-3">
        {t?.inTrash || t?.inSpam ? (
          <ToolButton label="Mover a Entrada" onClick={() => act(t.inSpam ? "notSpam" : "moveToInbox")} testId="action-inbox">
            <Inbox />
          </ToolButton>
        ) : (
          <ToolButton label="Archivar" keys="e" onClick={() => act("archive")} testId="action-archive">
            <Archive />
          </ToolButton>
        )}
        <ToolButton label="Eliminar" keys="#" onClick={() => act("trash")} testId="action-trash">
          <Trash2 />
        </ToolButton>
        <ToolButton label="Spam" keys="!" onClick={() => act("spam")} testId="action-spam">
          <OctagonAlert />
        </ToolButton>
        <span className="mx-1.5 h-4 w-px bg-border" />
        <ToolButton label="Categoría" keys="l" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} testId="action-category">
          <Tag />
        </ToolButton>
        <ToolButton label="Marcar como no leído" keys="u" onClick={() => act("markUnread")} testId="action-unread">
          <MailOpen />
        </ToolButton>
        {/* keyed by thread: moving to a starred thread swaps the button instead of fading its color (navigation never animates) */}
        <ToolButton key={t?.id ?? "none"} label={t?.starred ? "Quitar destacado" : "Destacar"} keys="s" onClick={() => toggleStar()} testId="action-star" active={t?.starred}>
          <Star className={cn(t?.starred && "fill-star")} />
        </ToolButton>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolButton label="Responder" keys="r" onClick={() => openCompose("reply")} testId="action-reply">
            <Reply />
          </ToolButton>
          <ToolButton label="Responder a todos" keys="a" onClick={() => openCompose("replyAll")} testId="action-reply-all">
            <ReplyAll />
          </ToolButton>
          <ToolButton label="Reenviar" keys="f" onClick={() => openCompose("forward")} testId="action-forward">
            <Forward />
          </ToolButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 pt-6 pb-16">
          {!detail ? (
            <div className="space-y-3">
              <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-32 animate-pulse rounded-xl bg-muted/70" />
            </div>
          ) : (
            <>
              <h2 data-testid="reader-subject" className="text-xl leading-tight font-semibold tracking-tight text-balance">
                {t!.subject || "(sin asunto)"}
              </h2>
              <div className="mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {account && <span>{account.email}</span>}
                {cats.map((c) => {
                  const auto = detail.categorization?.auto.find((a) => a.categoryId === c.id);
                  return (
                    <CategoryBadge key={c.id} color={c.color as CategoryColor}>
                      {c.name}
                      {auto && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                data-testid="auto-mark"
                                aria-label={`Única la añadió a ${c.name}: ${auto.reasons.join("; ")}`}
                                className="rounded-sm bg-foreground/10 px-1 text-[10px] font-medium uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                              >
                                auto
                              </button>
                            }
                          />
                          <Reasons title={`Única la añadió a ${c.name}`} reasons={auto.reasons} hint={`¿No es de ${c.name}? Quítala y aprenderá.`} />
                        </Tooltip>
                      )}
                      <button type="button" aria-label={auto ? `No es ${c.name}` : `Quitar ${c.name}`} className="opacity-60 hover:opacity-100" onClick={() => void removeFromCategory(c.id, [t!.id])}>
                        <X className="size-3" />
                      </button>
                    </CategoryBadge>
                  );
                })}
                {detail.categorization?.suggestions.map((sg, i) => {
                  const c = categories.find((x) => x.id === sg.categoryId);
                  if (!c) return null;
                  return (
                    <span key={sg.categoryId} data-testid="suggestion-chip" className="inline-flex h-5 items-center rounded-full border border-dashed border-primary/40 text-xs text-foreground">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button type="button" data-testid="suggestion-accept" onClick={() => void acceptSuggestion(t!.id, c.id)} className="inline-flex h-full items-center gap-1 rounded-l-full pr-1 pl-1.5 hover:bg-accent">
                              <CategoryDot color={c.color as CategoryColor} />¿{c.name}?{i === 0 && <Shortcut keys="y" className="ml-0.5 [&_kbd]:h-3.5 [&_kbd]:min-w-3.5 [&_kbd]:text-[10px]" />}
                            </button>
                          }
                        />
                        <Reasons title={`Parece de ${c.name} (${Math.round(sg.p * 100)}%)`} reasons={sg.reasons} hint={i === 0 ? "y: añadir · n: no es" : undefined} />
                      </Tooltip>
                      <button type="button" aria-label={`No es ${c.name}`} data-testid="suggestion-reject" onClick={() => void rejectSuggestion(t!.id, c.id)} className="inline-flex h-full items-center rounded-r-full px-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
              <div className="space-y-2.5">
                {detail.messages.map((m) => (
                  <Message
                    key={m.id}
                    m={m}
                    expanded={expanded.has(m.id)}
                    onToggle={() =>
                      setExpanded((s) => {
                        const n = new Set(s);
                        if (n.has(m.id)) n.delete(m.id);
                        else n.add(m.id);
                        return n;
                      })
                    }
                  />
                ))}
              </div>
              <div className="mt-5 flex gap-2">
                <Button variant="outline" size="sm" onClick={() => openCompose("reply")} data-testid="quick-reply">
                  <Reply /> Responder
                </Button>
                <Button variant="outline" size="sm" onClick={() => openCompose("replyAll")}>
                  <ReplyAll /> Responder a todos
                </Button>
                <Button variant="outline" size="sm" onClick={() => openCompose("forward")}>
                  <Forward /> Reenviar
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
