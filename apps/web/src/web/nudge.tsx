import { buttonVariants } from "@unica/ui/components/button";
import { cn } from "@unica/ui/lib/utils";
import { Laptop, Lock, X } from "lucide-react";
import { useState } from "react";

/** Where "Descargar para Mac" goes (set VITE_MAC_DOWNLOAD_URL at build time). */
export const MAC_DOWNLOAD_URL: string = import.meta.env.VITE_MAC_DOWNLOAD_URL || "https://unica.app/mac";

const DISMISSED = "unica:mac-banner-dismissed-at";
const WEEK = 7 * 86_400_000;

export function DownloadLink({ className, size = "sm", variant = "default" }: { className?: string; size?: "xs" | "sm" | "default"; variant?: "default" | "outline" | "ghost" }) {
  return (
    <a href={MAC_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" data-testid="mac-download" className={cn(buttonVariants({ size, variant }), className)}>
      Descargar para Mac
    </a>
  );
}

/** One quiet line above the list; dismissed for 7 days. */
export function DesktopBanner() {
  const [hidden, setHidden] = useState(() => Date.now() - Number(localStorage.getItem(DISMISSED) ?? 0) < WEEK);
  if (hidden) return null;
  return (
    <div data-testid="mac-banner" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-xs">
      <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="font-medium text-foreground">Única para Mac</span> es mucho más rápida
      </p>
      <DownloadLink size="xs" variant="ghost" className="h-6" />
      <button
        type="button"
        aria-label="Ocultar durante una semana"
        data-testid="mac-banner-dismiss"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => {
          localStorage.setItem(DISMISSED, String(Date.now()));
          setHidden(true);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** First run in the browser: what the Mac app adds, once, with a way to just continue. */
export function OnboardingNudge({ onContinue }: { onContinue?: () => void }) {
  return (
    <div data-testid="mac-onboarding" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">Descarga Única para Mac: es mucho más rápida</p>
      <p className="mt-1 text-xs text-muted-foreground">Además conecta cuentas IMAP/SMTP, da acceso a tus agentes (Claude Code, Codex) y sincroniza aunque cierres la ventana.</p>
      <div className="mt-2.5 flex gap-2">
        <DownloadLink />
        {onContinue && (
          <button type="button" className={buttonVariants({ size: "sm", variant: "ghost" })} onClick={onContinue}>
            Seguir en el navegador
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings → General on the web: what this browser can't do, plainly. */
export function MacSection() {
  return (
    <div data-testid="mac-section" className="my-3 rounded-xl border border-border p-3">
      <p className="text-sm font-medium">Única para Mac</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>Mucho más rápida: base de datos nativa en vez de WebAssembly en el navegador.</li>
        <li>Cuentas IMAP/SMTP (un navegador no puede abrir esas conexiones).</li>
        <li>Agentes: Claude Code y Codex acceden a tu correo por MCP.</li>
        <li>Sincroniza en segundo plano; aquí, solo mientras la pestaña está abierta.</li>
      </ul>
      <DownloadLink className="mt-2.5" />
    </div>
  );
}

const DESKTOP_ONLY = {
  imap: { title: "IMAP/SMTP necesita la app para Mac", body: "Un navegador no puede abrir conexiones IMAP ni SMTP. En el navegador puedes conectar Gmail." },
  agents: { title: "Los agentes necesitan la app para Mac", body: "Claude Code y Codex se conectan a Única por un socket local (MCP), que un navegador no puede ofrecer." },
} as const;

/** A feature the browser can't offer, said once, with the way to get it. */
export function DesktopOnly({ feature }: { feature: keyof typeof DESKTOP_ONLY }) {
  const copy = DESKTOP_ONLY[feature];
  return (
    <div data-testid={`desktop-only-${feature}`} className="flex gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="font-medium">{copy.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{copy.body}</p>
        <DownloadLink size="xs" variant="outline" className="mt-2" />
      </div>
    </div>
  );
}

/** Local mode, honestly, for the browser: what Única controls here and what it can't. */
export const WEB_LOCAL_MODE_HINT =
  "Única solo se conecta con Google (tu correo) y con IA de este equipo (localhost). En el navegador no puede fijar direcciones DNS ni controlar otras pestañas o extensiones.";
