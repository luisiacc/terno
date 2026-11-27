import { NumberField } from "@terno/ui/components/number-field";
import { t } from "@terno/i18n";
import { useState } from "react";
import { parseSyncWindow, SYNC_WINDOW_MAX, SYNC_WINDOW_MIN } from "~/lib/settings-values";

/**
 * A number of days, saved when it is valid (Enter or leaving the field);
 * anything else stays as typed with the reason, announced. A change of the
 * stored value shows in place (the same element: keyboard focus stays).
 */
export function DaysField({
  value,
  onSave,
  a11y,
  testId,
  placeholder,
  allowEmpty,
}: {
  value: number | null;
  /** null: emptied (only with allowEmpty) */
  onSave: (days: number | null) => Promise<void>;
  a11y: { id: string; "aria-describedby"?: string };
  testId?: string;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const errorId = `${a11y.id}-days-error`;
  const [draft, setDraft] = useState<number | null>(value);
  const [error, setError] = useState<string | null>(null);
  // the stored value changed: show it in the same element (keyboard focus stays)
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    // unless what is in the field is an edit of its own, typed since
    if (draft === shown) {
      setDraft(value);
      setError(null);
    }
  }
  /** what was typed or stepped to, or typed text that isn't a number */
  const commit = async (days: number | string | null) => {
    if (allowEmpty && days === null) {
      setError(null);
      if (value !== null) await onSave(null).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    const r = parseSyncWindow(days === null ? "" : String(days));
    if ("error" in r) return setError(r.error);
    setError(null);
    if (r.days === value) return;
    try {
      await onSave(r.days);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {/* a typed value out of range stays, with the reason (no clamping); the steppers stay within it */}
        <NumberField
          id={a11y.id}
          min={SYNC_WINDOW_MIN}
          max={SYNC_WINDOW_MAX}
          allowOutOfRange
          format={{ useGrouping: false }}
          className="h-7 w-28"
          data-testid={testId}
          value={draft}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={[a11y["aria-describedby"], error ? errorId : null].filter(Boolean).join(" ") || undefined}
          onValueChange={(days) => {
            setDraft(days);
            if (error) setError(null);
          }}
          onValueCommitted={(days) => void commit(days)}
          // Enter saves too, read as leaving the field reads it (the locale's rules), the field keeping focus
          commitOnEnter
          // text that isn't a number at all: it stays, with the same reason
          onUnparsed={(text) => void commit(text)}
        />
        {t("settings.days")}
      </span>
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive-ink" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </span>
      )}
    </span>
  );
}
