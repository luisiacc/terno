import { CATEGORY_COLORS, type CategoryColor } from "@terno/core";
import type { SettingsPatch } from "@terno/core/rpc";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@terno/ui/components/alert-dialog";
import { Button } from "@terno/ui/components/button";
import { ColorSwatch, ColorSwatches } from "@terno/ui/components/color-swatches";
import { Input } from "@terno/ui/components/input";
import { Textarea } from "@terno/ui/components/textarea";
import { ShieldCheck } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { t } from "@terno/i18n";
import { useId, useState } from "react";
import { COLOR_LABEL } from "~/lib/color-labels";
import { setApp, type SettingsTab } from "~/state/app";
import type { SettingId } from "./search-index";

export { COLOR_LABEL };

/**
 * Settings, inset-grouped (macOS System Settings): groups on a tint surface,
 * rows split by hairlines, the label and hint on the left, the control on
 * the right (or below, `stacked`). Each row names and describes its control:
 * the control receives the ids through `a11y`.
 */

/** Saves a settings patch; errors show as a snack, or are thrown to the caller with `quiet` (a field showing its own). */
export type SettingsUpdate = (patch: SettingsPatch, options?: { quiet?: boolean }) => Promise<void>;

export interface RowA11y {
  id: string;
  "aria-labelledby": string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** Plan 203: marks the element Settings' search opens for a setting (a row is marked by its `find`). */
export const findAttrs = (id: SettingId) => ({ "data-setting": id });

export function SettingsGroup({ title, footer, children, testId, className, find, busy }: {
  title?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  className?: string;
  /** plan 203: the whole group is the setting a search opens (a list of the user's own: rules, custom themes) */
  find?: SettingId;
  /** what it shows is still loading and may change (plan 203: a search waits for it before opening a row in it) */
  busy?: boolean;
}) {
  const titleId = useId();
  return (
    <section className={cn("mb-6 last:mb-0", className)} data-testid={testId} data-setting={find} aria-busy={busy || undefined} aria-labelledby={title ? titleId : undefined}>
      {title && (
        <h3 id={titleId} className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="hairline-divide card-group px-4">{children}</div>
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
  errorTestId,
  find,
  findScope,
}: {
  /**
   * Plan 203: the setting this row is in Settings' search (search-index.ts), which opens it here; false for a row
   * that isn't a setting (a status, an error, a list item)
   */
  find?: SettingId | false;
  /** plan 203: the row is itself one account's or category's (Appearance's photos from Google), as its disclosure is elsewhere */
  findScope?: `${"account" | "category"}:${number}`;
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
  errorTestId?: string;
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
        <p id={ids.error} role="alert" className="mt-0.5 text-xs text-destructive-ink" data-testid={errorTestId ?? (testId ? `${testId}-error` : undefined)}>
          {error}
        </p>
      )}
    </div>
  );
  if (stacked) {
    return (
      <div className="py-3" data-testid={testId} data-setting={find || undefined} data-setting-scope={findScope}>
        {text}
        <div className="mt-2.5">{children(a11y)}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 py-2.5" data-testid={testId} data-setting={find || undefined} data-setting-scope={findScope}>
      {text}
      <div className="flex shrink-0 items-center gap-2">{children(a11y)}</div>
    </div>
  );
}

/** Opens another section from a button in this one. Focus goes to that section's tab, which stays while the button's pane unmounts. */
export function openSettingsTab(tab: SettingsTab) {
  setApp({ settingsTab: tab });
  document.querySelector<HTMLElement>(`[data-settings-tab="${tab}"]`)?.focus();
}

/** A row that is only text (an explanation, a status) inside a group. */
/**
 * Where AI sends mail, under the group that turns it on (plan 131: no per-use consent, so it's said here once). A
 * group's footer, as the rest of Settings words its fine print: the shield, a short title, then the line.
 */
export function PrivacyNote({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <span className="flex items-start gap-1.5" data-testid={testId}>
      <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-foreground">{title}</span> {children}
      </span>
    </span>
  );
}

export function SettingsNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="py-2.5 text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * A text field that saves when it is left or on Enter (Esc puts the stored
 * value back). A change of the stored value shows as it happens, in the same
 * element (keyboard focus stays). A save that fails keeps what was typed,
 * with the reason.
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
  // the stored value changed (a save, another window): show it in the same element (focus stays),
  // unless the field holds an edit of its own (typed since; a save's echo must not eat what came after)
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (text === shown) {
      setText(value);
      setError(null);
    }
  }
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
        <span id={errorId} role="alert" className="text-xs text-destructive-ink">
          {error}
        </span>
      )}
    </span>
  );
}


/**
 * The palette as the shared swatches (one radio group: arrow keys, one tab stop), each named
 * by its color. The pick shows at once; a save that fails puts the stored
 * color back.
 */
export function ColorPicker({ value, onChange, a11y, name, testId }: { value: string; onChange: (color: CategoryColor) => Promise<void>; a11y: RowA11y; name: string; testId?: string }) {
  const [picked, setPicked] = useState(value);
  // the stored color changed: follow it in place (the focused radio stays), unless a pick of ours is
  // still on its way (arrows faster than saves: an older pick's echo must not undo a newer one)
  const [stored, setStored] = useState(value);
  if (value !== stored) {
    setStored(value);
    if (picked === stored) setPicked(value);
  }
  return (
    <ColorSwatches
      aria-labelledby={a11y["aria-labelledby"]}
      aria-describedby={a11y["aria-describedby"]}
      name={name}
      value={picked}
      onValueChange={(v) => {
        const c = v as CategoryColor;
        setPicked(c);
        onChange(c).catch(() => setPicked(value));
      }}
      data-testid={testId}
    >
      {CATEGORY_COLORS.map((c) => (
        <ColorSwatch key={c} value={c} label={t(COLOR_LABEL[c])} color={`var(--cat-${c})`} data-testid={testId ? `${testId}-${c}` : undefined} />
      ))}
    </ColorSwatches>
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
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirm: string;
  onConfirm: () => void | Promise<void>;
  testId?: string;
  /** where focus goes as it closes (opened from a menu, there's no trigger to go back to) */
  finalFocus?: () => HTMLElement | boolean | null;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
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
