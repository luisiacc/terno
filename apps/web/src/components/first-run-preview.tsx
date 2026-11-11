import { CUSTOM_PREFIX, THEME_TOKENS, type ThemeMode } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import type { DesignDefinition } from "@terno/ui/designs/index";
import type { Theme } from "@terno/ui/themes/registry";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Kbd } from "@terno/ui/components/kbd";
import { cn } from "@terno/ui/lib/utils";
import { READ_MEASURE, READING_COLUMN } from "~/lib/pane-lines";
import { Separator } from "@terno/ui/components/separator";
import { Archive, Forward, Inbox, ListFilter, Mail, OctagonAlert, Reply, Search, Send, SquarePen, Star, Tag, Trash2 } from "@terno/ui/icons";
import { formatNumber, t } from "@terno/i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { listDate, viewLabel } from "~/lib/format";
import { variant } from "~/lib/design";
import { ThreadRowView } from "./thread-row";
import { SenderAvatar } from "./sender-avatar";
import type { SampleMailbox } from "./first-run-sample";

/**
 * The app the preview draws: a laptop window's width, its height following the
 * panel's shape (within a window's range) so the picture fills the panel;
 * scaled down to fit (sizes, type and spacing stay the real ones).
 */
const CANVAS_W = 1180;
const CANVAS_H = { min: 680, max: 980 };

interface Props {
  design: DesignDefinition;
  /** the palette shown, and the [data-theme] it builds on (a custom theme's base) */
  theme: Theme;
  base: string;
  mode: ThemeMode;
  layout: AppSettings["layout"];
  density: AppSettings["density"];
  sample: SampleMailbox;
}

/**
 * Plan 98: the whole app in a choice, with sample mail. Its own appearance
 * subtree ([data-design], [data-theme], its own light or dark), so it can show
 * a mode the window isn't in; inert and hidden from assistive tech (it's a
 * picture of the app, not the app). Rows are the real ThreadRowView; the
 * sidebar, list header and reader mirror sidebar.tsx, thread-list.tsx's
 * Header and reader.tsx's ReaderHeader (same classes, same design variants):
 * a change there should be made here too. No store, no backend, no icons.
 */
export function FirstRunPreview({ design, theme, base, mode, layout, density, sample }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, h: CANVAS_H.min });
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => {
      const h = Math.min(CANVAS_H.max, Math.max(CANVAS_H.min, Math.round((CANVAS_W * el.clientHeight) / Math.max(1, el.clientWidth))));
      setFit({ scale: Math.min(el.clientWidth / CANVAS_W, el.clientHeight / h), h });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const custom = theme.id.startsWith(CUSTOM_PREFIX) ? Object.fromEntries(THEME_TOKENS.map((k) => [`--${k}`, theme.tokens[k]])) : {};
  const split = layout === "split";

  return (
    <div ref={frame} className="relative flex size-full items-center justify-center" aria-hidden inert>
      <div
        data-testid="first-run-preview"
        data-design={design.id}
        data-theme={base}
        data-layout={layout}
        data-mode={mode}
        className={cn("absolute top-1/2 left-1/2 overflow-hidden rounded-2xl bg-background font-sans text-foreground shadow-modal", mode === "dark" && "dark")}
        style={{ ...custom, colorScheme: mode, width: CANVAS_W, height: fit.h, transform: `translate(-50%, -50%) scale(${fit.scale})`, visibility: fit.scale ? undefined : "hidden" } as React.CSSProperties}
      >
        <div className="grid h-full" style={{ gridTemplateColumns: split ? "var(--sidebar-w) max(var(--list-min), var(--list-max)) minmax(0, 1fr)" : "var(--sidebar-w) minmax(0, 1fr)" }}>
          <Sidebar design={design} sample={sample} />
          <List design={design} sample={sample} wide={!split} compact={density === "compact"} selected={split ? sample.open.thread.id : null} />
          {split && <Reader design={design} sample={sample} />}
        </div>
      </div>
    </div>
  );
}

const NAV = "type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-sidebar-foreground border-y-[0.5px] border-transparent bg-clip-padding";

function Sidebar({ design, sample }: { design: DesignDefinition; sample: SampleMailbox }) {
  const unread = sample.threads.filter((x) => x.unread).length;
  const item = (icon: React.ReactNode, label: string, active = false, count?: number) => (
    <div className={cn(NAV, active && "type-nav-strong bg-sidebar-accent text-sidebar-accent-foreground")}>
      <span className="flex size-(--icon-nav) items-center justify-center text-sidebar-glyph">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className={cn("inline-block text-xs tabular", design.surfaces.inboxCount === "unread" ? "font-semibold text-unread-ink" : "text-muted-foreground")}>{formatNumber(count)}</span> : null}
    </div>
  );
  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="h-(--pane-bar) shrink-0" />
      {variant(design.variants.compose, {
        "list-header": null,
        "sidebar-outline": (
          <div className="shrink-0 px-2 pb-3">
            <div className="type-compose flex h-9 w-full items-center gap-2.5 rounded-lg bg-card px-3 text-foreground shadow-raised">
              <SquarePen className="size-4 text-primary" />
              <span className="min-w-0 flex-1 truncate">{t("compose.newMessage")}</span>
              <Kbd>C</Kbd>
            </div>
          </div>
        ),
        "sidebar-row": (
          <div className="shrink-0 px-(--sidebar-pad)">
            <div className="type-nav-strong flex h-(--nav-h) w-full items-center gap-2.5 px-2 text-sidebar-accent-foreground">
              <span className="flex size-(--icon-nav) items-center justify-center">
                <SquarePen className="size-(--icon-nav)" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("compose.newMessage")}</span>
            </div>
          </div>
        ),
        "sidebar-pill": (
          <div className="shrink-0 px-2 pb-3">
            <div className="type-compose flex h-9 w-full items-center gap-2.5 rounded-full border border-border bg-card pr-3 pl-2 text-foreground shadow-xs">
              <span className="flex size-(--icon-nav) items-center justify-center text-muted-foreground">
                <SquarePen className="size-(--icon-nav)" />
              </span>
              {t("list.compose")}
            </div>
          </div>
        ),
      })}
      <nav className="min-h-0 flex-1 px-(--sidebar-pad) pb-3">
        {item(<Inbox className="size-(--icon-nav)" />, viewLabel("inbox"), true, unread)}
        {item(<Star className="size-(--icon-nav)" />, viewLabel("starred"))}
        {item(<Send className="size-(--icon-nav)" />, viewLabel("sent"))}
        <div className="mt-(--nav-section-gap) mb-0.5 flex min-h-(--nav-section-h) items-center px-2">
          <span className="type-section-label text-muted-foreground">{t("sidebar.categories")}</span>
        </div>
        {sample.categories.map((c) => item(<CategoryDot color={c.color} />, c.name))}
      </nav>
    </aside>
  );
}

function List({ design, sample, wide, compact, selected }: { design: DesignDefinition; sample: SampleMailbox; wide: boolean; compact: boolean; selected: number | null }) {
  const v = design.variants;
  const quick = v.quickFilters;
  const kind = v.listHeader;
  const behindButton = v.search === "button";
  const unread = sample.threads.filter((x) => x.unread).length;
  const height = wide && !compact ? design.rows.wide : design.rows[compact ? "compact" : "comfortable"];
  const icon = (glyph: React.ReactNode) => <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground">{glyph}</span>;
  const filters = quick === "menu" && (
    // the header's All | Unread and its More filters (plan 158), drawn
    <span className="flex shrink-0 items-center gap-1">
      <span className="flex items-center gap-0.5 rounded-[calc(var(--radius-md)+var(--spacing)*0.5)] bg-field p-0.5 text-xs dark:bg-background">
        <span className="flex h-6 items-center rounded-md bg-card px-2.5 font-medium shadow-xs dark:bg-muted">{t("list.filter.all")}</span>
        <span className="flex h-6 items-center px-2.5 text-muted-foreground">{t("list.filter.unread")}</span>
      </span>
      {icon(<ListFilter />)}
    </span>
  );
  // as thread-list.tsx's Header: the filter control, then the header's actions
  const actions = (
    <>
      {behindButton && icon(<Search />)}
      {v.compose === "list-header" && (
        <span className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-[length:var(--ds-text-control)] font-medium shadow-xs">
          <SquarePen className="size-[1.15em] text-muted-foreground" />
          {t("compose.newMessage")}
        </span>
      )}
    </>
  );
  const field = !behindButton && (
    <div className="relative flex h-[30px] items-center rounded-lg bg-tint pr-2 pl-8 text-sm text-muted-foreground">
      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <span className="min-w-0 flex-1 truncate">{t("list.search.placeholder")}</span>
      <Kbd>/</Kbd>
    </div>
  );
  const subtitle = (at: string) => (
    <p className={cn("type-list-subtitle truncate text-muted-foreground tabular", at)}>
      <span className="type-list-subtitle-strong text-unread-ink">{t("list.unreadCount", { count: unread })}</span>
    </p>
  );
  // List's full-width list keeps its chrome on one line where the design's filters are a menu (thread-list.tsx's Header)
  const oneRow = wide && quick === "menu";
  return (
    <section className="flex h-full min-h-0 flex-col bg-pane">
      <div className="shrink-0 pr-4 pb-2 pl-2">
        {oneRow ? (
          // the title, then what the row leaves empty: the controls keep the right edge
          <div className="flex h-(--pane-bar) min-w-0 items-center gap-3 pr-1.5 pl-3">
            <h1 className={cn("min-w-0 truncate", kind === "title" ? "text-md font-semibold tracking-tight" : kind === "greeting" ? "type-greeting" : "type-list-title")}>{viewLabel("inbox")}</h1>
            {kind !== "title" && subtitle("shrink-0")}
            <div className="min-w-0 flex-1" />
            {filters}
            {field && <div className="w-64 shrink-0">{field}</div>}
            {actions}
          </div>
        ) : kind === "title" ? (
          <div className="flex h-(--pane-bar) items-center gap-2 pr-1.5 pl-3">
            <h1 className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight">{viewLabel("inbox")}</h1>
            {filters}
            {actions}
          </div>
        ) : (
          <>
            <div className="flex h-(--pane-bar) items-center gap-2 pr-1.5 pl-3">
              <h1 className={cn("min-w-0 flex-1 truncate", kind === "greeting" ? "type-greeting" : "type-list-title")}>{viewLabel("inbox")}</h1>
              {filters}
              <div className="flex shrink-0 items-center gap-0.5 empty:hidden">{actions}</div>
            </div>
            {subtitle("-mt-1.5 pb-2 pl-3")}
          </>
        )}
        {!oneRow && field}
        <div className="mt-1 flex min-w-0 items-center gap-3 overflow-hidden pl-3 empty:hidden">
        {quick === "chips" && (
          <div data-testid="first-run-preview-chips" className="flex shrink-0 gap-1.5 overflow-hidden py-0.5">
            {(["all", "unread", "people", "attachments", "starred"] as const).map((f) => (
              <span key={f} className={cn("flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-medium", f === "all" ? "bg-muted text-foreground" : "text-muted-foreground")}>
                {t(`list.filter.${f}`)}
              </span>
            ))}
          </div>
        )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {sample.threads.map((thread, i) => (
          <ThreadRowView
            key={thread.id}
            thread={thread}
            top={i * height}
            height={height}
            compact={compact}
            wide={wide}
            icons={false}
            layout={v.row}
            review={null}
            reminderTop={false}
            selected={thread.id === selected}
            checked={false}
            inSelection={thread.id === selected}
            account={undefined}
            categories={sample.categories}
            hasDraft={false}
            code={null}
            reminder={undefined}
            remindersList={false}
            interactive={false}
          />
        ))}
      </div>
    </section>
  );
}

function Reader({ design, sample }: { design: DesignDefinition; sample: SampleMailbox }) {
  const { thread, to, body } = sample.open;
  const tool = (glyph: React.ReactNode, active = false) => <span className={cn("flex size-8 items-center justify-center rounded-md text-muted-foreground [&_svg]:[--icon-line:var(--icon-line-toolbar)]", active && "text-star")}>{glyph}</span>;
  const recipients = <span className="block truncate text-xs text-muted-foreground">{t("reader.to")} {to}</span>;
  const subject = <h2 className="type-reader-subject">{thread.subject}</h2>;
  const column = READING_COLUMN;
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className={cn(column, "flex h-(--pane-bar) shrink-0 items-center gap-2 [&>:first-child]:-ml-2")}>
        <div className="flex items-center gap-0.5">
          {tool(<Archive />)}
          {tool(<Trash2 />)}
          {tool(<OctagonAlert />)}
        </div>
        <Separator orientation="vertical" className="my-auto h-4" />
        <div className="flex items-center gap-0.5">
          {tool(<Tag />)}
          {tool(<Mail />)}
          {tool(<Star />)}
        </div>
        <span className={cn("ml-auto flex h-8 items-center divide-x divide-border overflow-hidden rounded-[max(var(--cta-floor),var(--ds-radius-lg))] border border-border bg-card text-[length:var(--ds-text-control)] font-medium shadow-xs [&_svg]:[--icon-line:var(--icon-line-toolbar)]", design.variants.replyAction === "pill" && "rounded-full")}>
          <span className="flex h-full items-center gap-1.5 px-2.5">
            <Reply className="size-[1.15em] text-muted-foreground" />
            {t("actions.reply")}
            {design.variants.replyAction === "pill" && <Kbd>R</Kbd>}
          </span>
          {/* the reader's reply group as it is: Reply, then Forward (plan 158: no menu) */}
          <span className="flex h-full w-8 items-center justify-center">
            <Forward className="size-[1.15em] text-muted-foreground" />
          </span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn(column, "pt-2")}>
          {variant(design.variants.readerHeader, {
            classic: <div className="mb-3">{subject}</div>,
            "chips-display": <div className="mb-3">{subject}</div>,
            "sender-card": (
              <div className="mb-3">
                {subject}
                <div className="mt-1.5 flex items-start gap-2.5">
                  <SenderAvatar name={thread.fromName} email={thread.fromEmail} className="size-(--avatar-sender) text-xs" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2">
                      <span className="type-sender-name min-w-0 truncate">{thread.fromName}</span>
                      <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{thread.fromEmail}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{listDate(thread.lastDate)}</span>
                    </span>
                    {recipients}
                  </div>
                </div>
              </div>
            ),
          })}
          {design.variants.readerHeader !== "sender-card" && (
            <div className="flex items-start gap-2.5 pt-2.5 pb-1.5">
              <SenderAvatar name={thread.fromName} email={thread.fromEmail} className="size-(--avatar-message) text-2xs" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="type-sender-name truncate">{thread.fromName}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{listDate(thread.lastDate)}</span>
                </span>
                {recipients}
              </span>
            </div>
          )}
          <div className={cn("type-body whitespace-pre-wrap pt-1.5 text-foreground", READ_MEASURE)}>{body}</div>
        </div>
      </div>
    </section>
  );
}
