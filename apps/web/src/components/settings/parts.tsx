import { CATEGORY_COLORS, type CategoryColor } from "@unica/core";
import type { SettingsPatch } from "@unica/core/rpc";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@unica/ui/components/alert-dialog";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Input } from "@unica/ui/components/input";
import { Textarea } from "@unica/ui/components/textarea";
import { cn } from "@unica/ui/lib/utils";
import { useId, useState } from "react";

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

/**
 * A text field that saves when it is left or on Enter (Esc puts the stored
 * value back). Keyed by the stored value by its parent, so a change made
 * elsewhere shows. A save that fails keeps what was typed, with the reason.
 */
export function CommitInput({
  value,
  onCommit,
  validate,
  a11y,
  multiline,
  className,
  ...rest
}: {
  value: string;
  onCommit: (value: string) => Promise<void>;
  validate?: (value: string) => string | null;
  a11y: RowA11y | { id?: string; "aria-label"?: string; "aria-describedby"?: string };
  multiline?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement & HTMLTextAreaElement>, "value" | "onChange" | "className">) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const errorId = `${useId()}-error`;
  const commit = async () => {
    const problem = validate?.(text) ?? null;
    if (problem) return setError(problem);
    setError(null);
    if (text === value) return;
    try {
      await onCommit(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const shared = {
    ...rest,
    ...a11y,
    value: text,
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": [a11y["aria-describedby"], error ? errorId : null].filter(Boolean).join(" ") || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      if (error) setError(null);
    },
    onBlur: () => void commit(),
  };
  return (
    <span className="flex w-full flex-col gap-1">
      {multiline ? (
        <Textarea {...shared} className={cn("min-h-20 bg-background dark:bg-input/30", className)} />
      ) : (
        <Input
          {...shared}
          className={cn("h-7 bg-background dark:bg-input/30", className)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape" && text !== value) {
              // the field's own Esc: put the stored value back, the dialog stays
              e.stopPropagation();
              setText(value);
              setError(null);
            }
          }}
        />
      )}
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

export const COLOR_LABEL: Record<CategoryColor, string> = {
  rose: "Rosa",
  amber: "Ámbar",
  lime: "Lima",
  emerald: "Esmeralda",
  cyan: "Cian",
  indigo: "Índigo",
  violet: "Violeta",
  slate: "Pizarra",
};

/** The palette as native radio buttons (arrow keys, one tab stop), each named by its color. */
export function ColorPicker({ value, onChange, a11y, name, testId }: { value: string; onChange: (color: CategoryColor) => void; a11y: RowA11y; name: string; testId?: string }) {
  return (
    <div role="radiogroup" aria-labelledby={a11y["aria-labelledby"]} aria-describedby={a11y["aria-describedby"]} className="flex items-center gap-1" data-testid={testId}>
      {CATEGORY_COLORS.map((c) => (
        <label key={c} className="relative flex size-6 cursor-pointer items-center justify-center rounded-full has-focus-visible:ring-2 has-focus-visible:ring-ring">
          <input type="radio" name={name} value={c} checked={value === c} onChange={() => onChange(c)} aria-label={COLOR_LABEL[c]} className="peer sr-only" data-testid={testId ? `${testId}-${c}` : undefined} />
          <CategoryDot color={c} className="size-3.5 peer-checked:ring-2 peer-checked:ring-foreground peer-checked:ring-offset-2 peer-checked:ring-offset-tint" />
        </label>
      ))}
    </div>
  );
}

/** "Are you sure?" for something that can't be undone: says what goes away; Cancel is the default. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirm: string;
  onConfirm: () => void | Promise<void>;
  testId?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <Button
            variant="destructive"
            data-testid={testId ? `${testId}-confirm` : undefined}
            onClick={() => {
              onOpenChange(false);
              void onConfirm();
            }}
          >
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
