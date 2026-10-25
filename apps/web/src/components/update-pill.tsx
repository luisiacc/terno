import { localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@terno/ui/components/popover";
import { cn } from "@terno/ui/lib/utils";
import { ArrowDown, ChevronDown, RotateCw, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { formatBytes } from "~/lib/format";
import { checkForUpdates, downloadUpdate, errorText, installUpdate, openReleaseNotes, updateLater, usePill, useUpdates, type PillModel } from "~/lib/updates";
import { useWeb } from "~/web/lifecycle";

/**
 * The sidebar's update pill (T3 Code's flow): nothing while there's nothing
 * to say; "Update 0.2.0" when one waits for a download (manual mode, local
 * mode); a thin ring while it downloads; an accent "Restart to Update" once
 * it's ready. It opens a popover with the version, the notes, the size and
 * the one action that matters. The web build's "New version · Reload" sits
 * in the same place.
 */
export function UpdatePill() {
  const pill = usePill();
  if (pill.kind === "hidden") return null;
  return <div className="flex shrink-0 px-2 pt-1 pb-2">{pill.kind === "web" ? <WebReload /> : <DesktopPill pill={pill} />}</div>;
}

const capsule =
  "group flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const quiet = "border border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent";
const accent = "bg-sidebar-primary text-sidebar-primary-foreground shadow-xs hover:bg-sidebar-primary/90";

/** A 14 px ring: the download's progress (the track always shows, so 0 % still reads as a ring). */
export function ProgressRing({ percent, spinning }: { percent: number; spinning?: boolean }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 shrink-0 -rotate-90", spinning && "animate-spin motion-reduce:animate-none")} aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="1.75" className="stroke-sidebar-foreground/15" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, percent)) / 100)}
        className="stroke-sidebar-primary transition-[stroke-dashoffset] duration-base"
      />
    </svg>
  );
}

function label(pill: Exclude<PillModel, { kind: "hidden" } | { kind: "web" }>): string {
  switch (pill.kind) {
    case "available":
      return t("updates.pill.available", { version: pill.version });
    case "downloading":
      return t("updates.pill.downloading", { percent: pill.percent });
    case "verifying":
      return t("updates.pill.verifying");
    case "ready":
      return t(pill.deferred ? "updates.pill.waiting" : "updates.pill.restart");
    case "error":
      return t(pill.stage === "install" ? "updates.pill.notInstalled" : "updates.pill.failed");
  }
}

function DesktopPill({ pill }: { pill: Exclude<PillModel, { kind: "hidden" } | { kind: "web" }> }) {
  const [open, setOpen] = useState(false);
  const loud = pill.kind === "ready" && !pill.quiet && !pill.deferred;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" data-testid="update-pill" data-state={pill.kind} className={cn(capsule, loud ? accent : quiet, pill.kind === "error" && "text-destructive-ink")} />
        }
      >
        {pill.kind === "available" && <ArrowDown className="size-3.5 shrink-0 text-sidebar-primary" aria-hidden />}
        {pill.kind === "downloading" && <ProgressRing percent={pill.percent} />}
        {pill.kind === "verifying" && <ProgressRing percent={25} spinning />}
        {pill.kind === "ready" && (pill.deferred ? <ProgressRing percent={25} spinning /> : <RotateCw className={cn("size-3.5 shrink-0", !loud && "text-sidebar-primary")} aria-hidden />)}
        {pill.kind === "error" && <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate tabular-nums">{label(pill)}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-80 gap-3" data-testid="update-popover">
        <UpdateDetails pill={pill} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function UpdateDetails({ pill, close }: { pill: Exclude<PillModel, { kind: "hidden" } | { kind: "web" }>; close: () => void }) {
  const state = useUpdates((s) => s.state);
  const info = pill.kind === "ready" ? state?.ready : state?.available;
  const notesId = useId();
  const [notesOpen, setNotesOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const version = info?.version ?? "";
  const subtitle =
    pill.kind === "ready"
      ? pill.deferred
        ? t("updates.popover.deferred")
        : t("updates.popover.ready")
      : pill.kind === "available"
        ? state.localMode
          ? t("updates.popover.localMode")
          : t("updates.popover.available")
        : pill.kind === "downloading"
          ? t("updates.popover.downloading", { percent: pill.percent })
          : pill.kind === "verifying"
            ? t("updates.verifying")
            : state.error
              ? errorText(state.error.kind)
              : "";
  const meta = [info?.size ? formatBytes(info.size) : null, info?.releaseDate ? new Date(info.releaseDate).toLocaleDateString(localeTag(), { month: "short", day: "numeric", year: "numeric" }) : null].filter(Boolean).join(" · ");
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <PopoverTitle className="text-sm">{version ? `Terno ${version}` : t("updates.popover.untitled")}</PopoverTitle>
        <PopoverDescription className="text-xs leading-relaxed" data-testid="update-subtitle">
          {subtitle}
        </PopoverDescription>
        {meta && <p className="text-2xs text-muted-foreground tabular-nums">{meta}</p>}
      </div>
      {info?.notes ? (
        <div className="hairline-t flex flex-col gap-1.5 pt-2.5">
          <button
            type="button"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onClick={() => setNotesOpen((o) => !o)}
            className="flex items-center gap-1 self-start rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("updates.whatsNew")}
            <ChevronDown className={cn("size-3 transition-transform duration-fast", !notesOpen && "-rotate-90")} aria-hidden />
          </button>
          {notesOpen && (
            <p id={notesId} className="max-h-40 overflow-y-auto pr-1 text-xs leading-relaxed whitespace-pre-line text-popover-foreground" data-testid="update-notes">
              {info.notes}
            </p>
          )}
        </div>
      ) : (
        version && (
          <button type="button" onClick={() => openReleaseNotes(version)} className="self-start rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {t("updates.releaseNotes")}
          </button>
        )
      )}
      <div className="flex justify-end gap-2">
        {pill.kind === "ready" && (
          <>
            <Button size="sm" variant="ghost" onClick={() => (updateLater(), close())} data-testid="update-later">
              {t("updates.later")}
            </Button>
            <Button size="sm" disabled={busy || pill.deferred} onClick={() => act(installUpdate)} data-testid="update-restart">
              {t("updates.restartNow")}
            </Button>
          </>
        )}
        {pill.kind === "available" && (
          <>
            <Button size="sm" variant="ghost" onClick={close}>
              {t("updates.later")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act(downloadUpdate)} data-testid="update-download">
              {t("updates.download")}
            </Button>
          </>
        )}
        {pill.kind === "error" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(pill.stage === "install" || !state.available ? checkForUpdates : downloadUpdate)} data-testid="update-retry">
            {t("updates.tryAgain")}
          </Button>
        )}
      </div>
    </>
  );
}

/** Web: a newer deployment is installed and waiting; reloading takes it (every tab saves its drafts first). */
function WebReload() {
  const update = useWeb((s) => s.update);
  return (
    <button type="button" data-testid="update-pill" data-state="web" className={cn(capsule, accent)} onClick={() => update?.apply()}>
      <RotateCw className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{t("updates.pill.webReload")}</span>
    </button>
  );
}
