import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Keyboard } from "lucide-react";
import { Suspense, useState } from "react";
import { setApp } from "~/state/app";
import { MacSection } from "~/lib/web-parts";
import { parseSyncWindow, SYNC_WINDOW_MAX, SYNC_WINDOW_MIN } from "~/lib/settings-values";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const WEB = import.meta.env.VITE_TARGET === "web";

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
  const [text, setText] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  // the stored value changed: show it in the same element (keyboard focus stays)
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    // unless what is in the field is an edit of its own, typed since
    if (text === (shown === null ? "" : String(shown))) {
      setText(value === null ? "" : String(value));
      setError(null);
    }
  }
  const commit = async () => {
    if (allowEmpty && text.trim() === "") {
      setError(null);
      if (value !== null) await onSave(null).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    const r = parseSyncWindow(text);
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
        <Input
          {...a11y}
          type="number"
          inputMode="numeric"
          min={SYNC_WINDOW_MIN}
          max={SYNC_WINDOW_MAX}
          step={1}
          className="h-7 w-20 text-right tabular-nums"
          data-testid={testId}
          value={text}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={[a11y["aria-describedby"], error ? errorId : null].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
        />
        días
      </span>
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive-ink" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </span>
      )}
    </span>
  );
}

const DENSITY = [
  { value: "comfortable", label: "Cómoda" },
  { value: "compact", label: "Compacta" },
] as const;

export function GeneralTab({ settings, update, onLocalOff }: { settings: AppSettings; update: SettingsUpdate; onLocalOff: () => void }) {
  return (
    <div data-testid="general-tab">
      <SettingsGroup>
        <SettingsRow
          testId="local-mode-row"
          label="Modo local"
          hint={
            WEB
              ? "Terno solo se conecta con Google (tu correo) y con IA de este equipo (localhost). En el navegador no puede fijar direcciones DNS ni controlar otras pestañas o extensiones."
              : "Nada sale de este Mac salvo el correo con tus servidores. La IA solo puede usar modelos de este Mac."
          }
        >
          {(a) => <Switch {...a} data-testid="local-mode-switch" checked={settings.localMode} onCheckedChange={(on) => (on ? void update({ localMode: true }) : onLocalOff())} />}
        </SettingsRow>
        <SettingsRow label="Cargar imágenes remotas siempre" hint={settings.localMode ? "El modo local las bloquea siempre." : "Por defecto se bloquean para evitar rastreo; puedes cargarlas en cada correo."}>
          {(a) => (
            <Switch
              {...a}
              data-testid="remote-images-switch"
              disabled={settings.localMode}
              checked={settings.remoteImages === "always" && !settings.localMode}
              onCheckedChange={(on) => void update({ remoteImages: on ? "always" : "ask" })}
            />
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Lista">
        <SettingsRow label="Densidad" hint="Compacta muestra una línea por conversación.">
          {({ id: _id, ...a }) => (
            <Select value={settings.density} onValueChange={(v) => void update({ density: v as AppSettings["density"] })} items={DENSITY.map((d) => ({ ...d }))}>
              <SelectTrigger {...a} size="sm" className="w-32" data-testid="density-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENSITY.map((d) => (
                  <SelectItem key={d.value} value={d.value} data-testid={`density-${d.value}`}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sincronización">
        <SettingsRow labelFor label="Ventana de sincronización" hint="Días de correo a descargar al conectar una cuenta. Cada cuenta puede tener la suya en Cuentas.">
          {(a) => <DaysField a11y={a} testId="sync-window" value={settings.syncWindowDays} onSave={(days) => update({ syncWindowDays: days ?? settings.syncWindowDays }, { quiet: true })} />}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Teclado">
        <SettingsRow label="Atajos de teclado" hint="Terno se usa entero con el teclado. También con ?, en cualquier momento.">
          {({ id: _id, "aria-labelledby": _l, ...a }) => (
            <Button {...a} variant="outline" size="sm" data-testid="open-shortcuts" onClick={() => setApp({ dialog: "shortcuts" })}>
              <Keyboard /> Ver atajos
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      {MacSection && (
        <Suspense>
          <MacSection />
        </Suspense>
      )}
    </div>
  );
}
