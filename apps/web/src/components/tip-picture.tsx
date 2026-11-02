import { cn } from "@terno/ui/lib/utils";
import { t } from "@terno/i18n";
import { MousePointer, MouseRightClick } from "@terno/ui/icons";
import type { ReactNode } from "react";

/**
 * Plan 113: the pieces a tip draws its picture with: the app's own rows, menus and gestures in miniature, so the picture
 * looks like what you'll do. Decorative (the tip's words say it all); laid out by the tip, mostly in normal flow, with a
 * menu placed where it would open.
 */
export function TipPicture({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div aria-hidden data-testid="tip-picture" className={cn("relative overflow-hidden rounded-lg bg-sidebar p-1.5 text-sidebar-foreground hairline", className)}>
      {children}
    </div>
  );
}

/** A sidebar row: its glyph, its name, a quiet mark after it (`note`); `active` as the row you're on. */
export function TipRow({ icon, label, note, active, className }: { icon: ReactNode; label: string; note?: ReactNode; active?: boolean; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-xs", active && "bg-sidebar-accent text-sidebar-accent-foreground", className)}>
      <span className="flex size-3.5 shrink-0 items-center justify-center text-sidebar-glyph">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {note}
    </div>
  );
}

/** What your hand does, as a chip beside what it does it to. */
export function TipGesture({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-hairline">
      {icon}
      {label}
    </span>
  );
}

export const TipRightClick = () => <TipGesture icon={<MouseRightClick className="size-3.5" />} label={t("tip.rightClick")} />;

/** A menu as it opens (place it with `className`: absolute, where the gesture would open it). */
export function TipMenu({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("w-44 rounded-md bg-popover p-1 shadow-popover", className)}>{children}</div>;
}

/** One of its items; `pointer`: the one to choose, highlighted under the pointer. */
export function TipMenuItem({ icon, label, pointer }: { icon: ReactNode; label: string; pointer?: boolean }) {
  return (
    <div className={cn("relative flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs [&_svg]:size-[1.15em]", pointer ? "bg-accent text-accent-foreground" : "text-muted-foreground")}>
      {icon}
      <span className="truncate">{label}</span>
      {pointer && <MousePointer className="absolute top-2.5 right-3 size-4! fill-background text-foreground" />}
    </div>
  );
}
