import type { SettingsPatch } from "@unica/core/rpc";
import { cn } from "@unica/ui/lib/utils";
import { useId } from "react";

/**
 * Settings, inset-grouped (macOS System Settings): groups on a tint surface,
 * rows split by hairlines, the label and hint on the left, the control on
 * the right (or below, `stacked`). Each row names and describes its control:
 * the control receives the ids through `a11y`.
 */

/** Saves a settings patch; errors show as a toast, or are thrown to the caller with `quiet` (a field showing its own). */
export type SettingsUpdate = (patch: SettingsPatch, options?: { quiet?: boolean }) => Promise<void>;

export interface RowA11y {
  id: string;
  "aria-labelledby": string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export function SettingsGroup({ title, footer, children, testId, className }: { title?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; testId?: string; className?: string }) {
  const titleId = useId();
  return (
    <section className={cn("mb-6 last:mb-0", className)} data-testid={testId} aria-labelledby={title ? titleId : undefined}>
      {title && (
        <h3 id={titleId} className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="hairline-divide rounded-[10px] bg-tint px-4">{children}</div>
      {footer && <div className="mt-1.5 px-1 text-xs text-muted-foreground">{footer}</div>}
    </section>
  );
}

export function SettingsRow({
  label,
  hint,
  error,
  children,
  testId,
  stacked,
  labelFor,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** announced (role=alert), linked to the control, which is marked invalid */
  error?: string | null;
  children: (a11y: RowA11y) => React.ReactNode;
  testId?: string;
  /** the control goes below the label, full width (lists, text areas, grids) */
  stacked?: boolean;
  /** a native control: the label is a <label for> (clicking it focuses the control) */
  labelFor?: boolean;
}) {
  const base = useId();
  const ids = { control: `${base}-control`, label: `${base}-label`, hint: `${base}-hint`, error: `${base}-error` };
  const describedBy = [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean).join(" ") || undefined;
  const a11y: RowA11y = { id: ids.control, "aria-labelledby": ids.label, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) };
  const Label = labelFor ? "label" : "p";
  const text = (
    <div className="min-w-0">
      <Label id={ids.label} htmlFor={labelFor ? ids.control : undefined} className="block text-sm font-medium">
        {label}
      </Label>
      {hint && (
        <p id={ids.hint} className="mt-0.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={ids.error} role="alert" className="mt-0.5 text-xs text-destructive" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </p>
      )}
    </div>
  );
  if (stacked) {
    return (
      <div className="py-3" data-testid={testId}>
        {text}
        <div className="mt-2.5">{children(a11y)}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 py-2.5" data-testid={testId}>
      {text}
      <div className="flex shrink-0 items-center gap-2">{children(a11y)}</div>
    </div>
  );
}

/** A row that is only text (an explanation, a status) inside a group. */
export function SettingsNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="py-2.5 text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  );
}
