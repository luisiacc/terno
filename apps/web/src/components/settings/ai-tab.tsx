import type { CompatiblePreset, ModelInfo, PresetDescriptor, ProviderDescriptor } from "@unica/core";
import type { AiTestResult, AppSettings, SettingsPatch } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { Input } from "@unica/ui/components/input";
import { Label } from "@unica/ui/components/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { cn } from "@unica/ui/lib/utils";
import { CircleAlert, CircleCheck, LaptopMinimalCheck, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CHOICE_LABEL,
  choiceOf,
  CLOUD_CHOICES,
  DEFAULT_ENDPOINT,
  endpointOf,
  errorHelp,
  hostOf,
  isLoopbackUrl,
  LOCAL_CHOICES,
  OUTPUT_LABEL,
  PRESET_ENDPOINT,
  PRESET_LABEL,
  privacyLine,
  providerName,
  type ProviderChoice,
} from "~/lib/ai";
import { formatBytes } from "~/lib/format";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reconcileSettings } from "~/lib/appearance";

const targetKey = (ai: AppSettings["ai"]) => [ai.provider, ai.preset ?? "", ai.baseURL ?? "", ai.model].join("|");

type Catalog = { providers: ProviderDescriptor[]; presets: PresetDescriptor[] };
type Discovery = { state: "idle" } | { state: "loading" } | { state: "done"; models: ModelInfo[] } | { state: "error"; message: string };

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-b border-border py-3 last:border-0">
      <Label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function AiTab({ settings, update }: { settings: AppSettings; update: (patch: SettingsPatch) => Promise<void> }) {
  const { ai, localMode } = settings;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const choice = choiceOf(ai);
  const presetNeedsKey = ai.provider === "compatible" && (catalog?.presets.find((p) => p.id === ai.preset)?.needsKey ?? ai.preset !== "custom");
  const descriptor = catalog?.providers.find((p) => p.id === ai.provider);
  const needsKey = ai.provider === "compatible" ? presetNeedsKey : (descriptor?.needsKey ?? false);
  const showsKey = needsKey || (ai.provider === "compatible" && choice === "compatible");
  const showsEndpoint = LOCAL_CHOICES.includes(choice) || (ai.provider === "compatible" && (ai.preset === "custom" || ai.preset === "azure"));
  // a custom endpoint may still resolve to this Mac: the backend decides when it connects
  const paused = localMode && !ai.local && ai.provider !== "none" && !(ai.provider === "compatible" && ai.preset === "custom");

  useEffect(() => {
    void client.call("ai.providers", {}).then(setCatalog);
  }, []);

  // ── endpoint (validated inline, saved after a pause in typing)
  const endpoint = endpointOf(ai) ?? "";
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  useEffect(() => setEndpointDraft(endpoint), [endpoint]);
  useEffect(() => {
    if (endpointDraft === endpoint) return;
    const timer = setTimeout(() => {
      const value = endpointDraft.trim();
      if (!/^https?:\/\/[^/\s]+/i.test(value)) return setEndpointError("Escribe una URL http:// o https://");
      if (localMode && LOCAL_CHOICES.includes(choice) && !isLoopbackUrl(value) && choice !== "local-server") {
        return setEndpointError("En modo local el endpoint debe estar en este Mac (127.0.0.1 o localhost).");
      }
      setEndpointError(null);
      update({ ai: { baseURL: value } }).catch((e) => setEndpointError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => clearTimeout(timer);
  }, [endpointDraft, endpoint, localMode, choice, update]);

  // ── model discovery: when the tab opens and whenever provider or endpoint change (debounced)
  const [discovery, setDiscovery] = useState<Discovery>({ state: "idle" });
  const discoverySeq = useRef(0);
  const canDiscover = ai.provider !== "none" && !paused && (!needsKey || ai.hasKey);
  const discover = async () => {
    const seq = ++discoverySeq.current;
    setDiscovery({ state: "loading" });
    try {
      const { models } = await client.call("ai.listModels", { provider: ai.provider, baseURL: ai.baseURL ?? undefined, preset: ai.preset ?? undefined });
      if (seq === discoverySeq.current) setDiscovery({ state: "done", models });
    } catch (error) {
      if (seq === discoverySeq.current) setDiscovery({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => {
    if (!canDiscover) {
      discoverySeq.current++;
      setDiscovery({ state: "idle" });
      return;
    }
    const timer = setTimeout(() => void discover(), 400);
    return () => clearTimeout(timer);
    // discover reads the inputs listed here; the model matters too (Ollama reports the selected one's context window)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.provider, ai.baseURL, ai.preset, ai.hasKey, ai.model, canDiscover]);

  // ── test connection: a result only counts for the exact target it tested
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const testSeq = useRef(0);
  const target = targetKey(ai);
  useEffect(() => {
    testSeq.current++;
    setTest(null);
    setTesting(false);
  }, [target]);
  const runTest = async () => {
    const seq = ++testSeq.current;
    setTesting(true);
    try {
      const result = await client.call("ai.test", { provider: ai.provider, model: ai.model, baseURL: ai.baseURL ?? undefined, preset: ai.preset ?? undefined });
      // the user may have switched provider meanwhile: a late answer must not touch the new one
      if (seq !== testSeq.current) return;
      setTest(result);
      const capabilities = result.ok ? result.capabilities : undefined;
      if (capabilities) {
        setApp((state) => (state.settings && targetKey(state.settings.ai) === target ? { settings: { ...state.settings, ai: { ...state.settings.ai, capabilities } } } : {}));
      }
    } finally {
      if (seq === testSeq.current) setTesting(false);
    }
  };

  // ── key
  const [key, setKey] = useState("");
  const saveKey = async (value: string) => {
    const next = await client.call("ai.setKey", { provider: ai.provider, preset: ai.preset ?? undefined, value });
    setApp({ settings: reconcileSettings(next) });
    setKey("");
    toast.success(value ? "API key guardada en el llavero" : "API key eliminada");
  };

  const select = async (value: ProviderChoice) => {
    try {
      if (value === "local-server") {
        const current = ai.profiles.compatible;
        const url = current?.preset === "custom" && current.baseURL && isLoopbackUrl(current.baseURL) ? current.baseURL : DEFAULT_ENDPOINT["local-server"]!;
        await update({ ai: { provider: "compatible", preset: "custom", baseURL: url } });
      } else if (value === "compatible") {
        const current = ai.profiles.compatible;
        const keep = current?.preset && current.preset !== "custom" ? current.preset : "openrouter";
        await update({ ai: { provider: "compatible", preset: keep, baseURL: keep === "azure" ? (current?.baseURL ?? null) : null } });
      } else {
        await update({ ai: { provider: value } });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const selectable = (c: ProviderChoice) => c !== "fake" || catalog?.providers.some((p) => p.id === "fake");
  const cloudDisabled = localMode;
  const items = [...LOCAL_CHOICES, ...CLOUD_CHOICES, "fake" as const, "none" as const].filter(selectable).map((c) => ({ value: c, label: CHOICE_LABEL[c] }));
  const models = discovery.state === "done" ? discovery.models : [];

  return (
    <div className="py-2" data-testid="ai-tab">
      {localMode && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-primary/25 bg-accent/60 px-3 py-2 text-xs text-accent-foreground" data-testid="ai-local-banner">
          <LaptopMinimalCheck className="mt-px size-3.5 shrink-0" />
          <span>
            Modo local: la IA solo puede usar modelos de este Mac.
            {paused && ` ${providerName(ai)} queda en pausa hasta que lo desactives.`}
          </span>
        </div>
      )}

      <Field label="Proveedor" hint="La IA crea filtros a partir de tu descripción.">
        <Select value={choice} onValueChange={(v) => void select(v as ProviderChoice)} items={items}>
          <SelectTrigger size="sm" className="w-64" data-testid="ai-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>En este Mac</SelectLabel>
              {LOCAL_CHOICES.map((c) => (
                <SelectItem key={c} value={c} data-testid={`ai-choice-${c}`}>
                  {CHOICE_LABEL[c]}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{cloudDisabled ? "En la nube · desactiva el modo local para usarla" : "En la nube"}</SelectLabel>
              {CLOUD_CHOICES.map((c) => (
                <SelectItem key={c} value={c} disabled={cloudDisabled} data-testid={`ai-choice-${c}`}>
                  {CHOICE_LABEL[c]}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            {selectable("fake") && (
              <SelectItem value="fake" data-testid="ai-choice-fake">
                {CHOICE_LABEL.fake}
              </SelectItem>
            )}
            <SelectItem value="none" data-testid="ai-choice-none">
              {CHOICE_LABEL.none}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {ai.provider === "compatible" && choice === "compatible" && (
        <Field label="Servicio">
          <Select
            value={ai.preset ?? "openrouter"}
            onValueChange={(v) => void update({ ai: { preset: v as CompatiblePreset, baseURL: null } }).catch((e) => toast.error(String(e)))}
            items={(Object.keys(PRESET_LABEL) as CompatiblePreset[]).map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
          >
            <SelectTrigger size="sm" className="w-64" data-testid="ai-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABEL) as CompatiblePreset[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PRESET_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {showsEndpoint && (
        <Field
          label={ai.preset === "azure" ? "Endpoint de Azure" : "Endpoint"}
          htmlFor="ai-endpoint"
          hint={endpointError ? <span className="text-destructive" data-testid="ai-endpoint-error">{endpointError}</span> : ai.preset === "azure" ? "https://<recurso>.openai.azure.com · el modelo es el nombre del deployment." : undefined}
        >
          <Input
            id="ai-endpoint"
            data-testid="ai-endpoint"
            className="h-8 font-mono text-xs"
            value={endpointDraft}
            placeholder={ai.preset === "azure" ? "https://mi-recurso.openai.azure.com" : (DEFAULT_ENDPOINT[choice] ?? PRESET_ENDPOINT[ai.preset ?? "custom"] ?? "http://127.0.0.1:8080/v1")}
            aria-invalid={endpointError ? true : undefined}
            onChange={(e) => setEndpointDraft(e.target.value)}
          />
        </Field>
      )}

      {showsKey && (
        <Field label={`API key de ${providerName(ai)}${needsKey ? "" : " (opcional)"}`} htmlFor="ai-key" hint="Se cifra con el llavero de macOS y solo se envía a este proveedor.">
          {ai.hasKey ? (
            <div className="flex items-center gap-2 text-sm" data-testid="ai-key-saved">
              <span className="text-success">Guardada{ai.keyHint ? ` · …${ai.keyHint}` : ""}</span>
              <Button variant="ghost" size="xs" onClick={() => void saveKey("")}>
                Quitar
              </Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void saveKey(key.trim());
              }}
            >
              <Input id="ai-key" data-testid="ai-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ai.provider === "anthropic" ? "sk-ant-…" : "sk-…"} className="h-8" />
              <Button type="submit" size="sm" disabled={!key.trim()}>
                Guardar
              </Button>
            </form>
          )}
        </Field>
      )}

      {ai.provider !== "none" && ai.provider !== "fake" && (
        <Field label="Modelo" htmlFor="ai-model">
          <div className="flex gap-2">
            <Input
              key={`${ai.provider}:${ai.model}`}
              id="ai-model"
              data-testid="ai-model"
              className="h-8 font-mono text-xs"
              defaultValue={ai.model}
              placeholder={choice === "ollama" ? "qwen3:8b" : "nombre del modelo"}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value !== ai.model) void update({ ai: { model: value } });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <Button variant="outline" size="icon-sm" aria-label="Actualizar modelos" disabled={!canDiscover || discovery.state === "loading"} onClick={() => void discover()}>
              <RefreshCw className={cn(discovery.state === "loading" && "animate-spin")} />
            </Button>
          </div>
          {discovery.state === "error" && (
            <p className="flex items-center gap-1.5 text-xs text-destructive" data-testid="ai-discovery-error">
              <CircleAlert className="size-3.5" /> {discovery.message}
            </p>
          )}
          {needsKey && !ai.hasKey && !paused && <p className="text-xs text-muted-foreground">Guarda la API key para ver los modelos disponibles.</p>}
          {models.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border" data-testid="ai-models" aria-label="Modelos disponibles">
              {models.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    data-testid="ai-model-option"
                    data-selected={m.id === ai.model || undefined}
                    onClick={() => void update({ ai: { model: m.id } })}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted data-selected:bg-accent data-selected:text-accent-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{m.label ?? m.id}</span>
                    {m.loaded && <span className="rounded bg-success/15 px-1 text-2xs text-success">cargado</span>}
                    {m.contextTokens ? <span className="text-muted-foreground tabular">{Math.round(m.contextTokens / 1024)}k ctx</span> : null}
                    {m.sizeBytes ? <span className="text-muted-foreground tabular">{formatBytes(m.sizeBytes)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      )}

      {ai.provider !== "none" && (
        <div className="space-y-2 border-b border-border py-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" data-testid="ai-test" disabled={testing || paused || (ai.provider !== "fake" && !ai.model)} onClick={() => void runTest()}>
              {testing && <Loader2 className="animate-spin" />} Probar conexión
            </Button>
            {test?.ok && (
              <span className="flex items-center gap-1.5 text-xs text-success" data-testid="ai-test-result">
                <CircleCheck className="size-3.5" /> Conectado · <span data-testid="ai-test-latency">{test.latencyMs} ms</span> · {OUTPUT_LABEL[test.capabilities!.output]}
              </span>
            )}
            {!test && ai.capabilities?.probedAt && <span className="text-xs text-muted-foreground">Última prueba: {OUTPUT_LABEL[ai.capabilities.output]}</span>}
          </div>
          {test?.warning && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="ai-test-warning">
              <CircleAlert className="size-3.5 shrink-0" /> {test.warning}
            </p>
          )}
          {test && !test.ok && (
            <div className="text-xs" data-testid="ai-test-error">
              <p className="text-destructive">{test.error?.message}</p>
              {errorHelp(test.error?.kind, ai) && <p className="mt-0.5 text-muted-foreground">{errorHelp(test.error?.kind, ai)}</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs" data-testid="ai-privacy">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">Privacidad{ai.provider !== "none" && !ai.local && hostOf(ai) ? ` · ${hostOf(ai)}` : ""}</p>
          <p className="mt-0.5 text-muted-foreground">{privacyLine(ai)}</p>
        </div>
      </div>
    </div>
  );
}
