import { localized } from "~/lib/i18n";
import type { AiProviderId, CompatiblePreset, ModelInfo, PresetDescriptor, ProviderDescriptor } from "@terno/core";
import type { AiSettings, AiTestResult, AppSettings } from "@terno/core/rpc";
import { aiFeaturesAvailable, routeFor } from "@terno/core";
import { AiUseGroup, AskGroup, DigestGroup, FollowupsGroup, SummariesGroup } from "./ai-summaries";
import { DraftingGroup } from "./ai-drafting";
import { useAiDraftUi } from "~/lib/ai-draft-state";
import { openSettingsTab, PrivacyNote, SettingsGroup, SettingsNote, SettingsRow, type RowA11y, type SettingsUpdate } from "./parts";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { CircleAlert, CircleCheck, RefreshCw } from "@terno/ui/icons";
import { refText, t } from "@terno/i18n";
import { useEffect, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import {
  choiceLabel,
  choiceOf,
  CLOUD_CHOICES,
  DEFAULT_ENDPOINT,
  disclosureLine,
  endpointOf,
  errorHelp,
  hostOf,
  isLoopbackUrl,
  KEYED,
  LOCAL_CHOICES,
  OUTPUT_LABEL,
  PRESET_ENDPOINT,
  presetLabel,
  PRESETS,
  providerLabel,
  providerName,
  routingLine,
  type ProviderChoice,
} from "~/lib/ai";
import { formatBytes } from "~/lib/format";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reconcileSettings } from "~/lib/appearance";
import WritingStyle from "./writing-style";


// the keys too: on Claude or OpenAI they decide what a test reaches (plan 168)
const targetKey = (ai: AppSettings["ai"]) => [ai.provider, ai.preset ?? "", ai.baseURL ?? "", ai.model, ...KEYED.map((p) => `${ai.keys[p]?.hasKey}:${ai.keys[p]?.keyHint}`)].join("|");

/** Plan 168: the model a key is tested with: the one drafting would run on with only that key. */
const keyedModel = (provider: "anthropic" | "openai") => routeFor("writing", { provider, model: "", keys: { [provider]: { hasKey: true, keyHint: null } } })!.model;

/** One key's state, the configured provider's as `ai` has it, the other's from `ai.keys` (plan 168: both can be saved here). */
function keyStateOf(ai: AiSettings, provider: AiProviderId) {
  if (provider === ai.provider) return { hasKey: ai.hasKey, hint: ai.keyHint, unreadable: ai.keyUnreadable, confirmed: ai.keyConfirmed, origin: ai.keyOrigin, host: hostOf(ai) };
  const key = ai.keys[provider];
  const profile = ai.profiles[provider];
  return { hasKey: key?.hasKey === true, hint: key?.keyHint ?? null, unreadable: key?.keyUnreadable === true, confirmed: key?.keyConfirmed !== false, origin: key?.keyOrigin ?? null, host: hostOf({ provider, preset: profile?.preset ?? null, baseURL: profile?.baseURL ?? null, local: false }) };
}

/** A provider's API key: saved, removed, confirmed for a moved endpoint, or saved again when it can't be read. */
function KeyRow({ ai, provider, label, name, placeholder, testId }: { ai: AiSettings; provider: AiProviderId; label: string; name: string; placeholder: string; testId: string }) {
  const [key, setKey] = useState("");
  const state = keyStateOf(ai, provider);
  const preset = provider === ai.provider ? (ai.preset ?? undefined) : undefined;
  const saveKey = async (value: string) => {
    try {
      const next = await client.call("ai.setKey", { provider, preset, value });
      setApp({ settings: reconcileSettings(next) });
      setKey("");
      snack.success(value ? t("ai.key.savedSnack") : t("ai.key.removedSnack"));
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  const keyForm = (a: RowA11y) => (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void saveKey(key.trim());
      }}
    >
      <Input {...a} data-testid={testId} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={placeholder} className="h-7 bg-background dark:bg-input/30" />
      <Button type="submit" size="sm" disabled={!key.trim()}>
        {t("common.save")}
      </Button>
    </form>
  );
  return (
    <SettingsRow stacked labelFor label={label} hint={t("ai.key.hint")} testId={`ai-key-row-${provider}`}>
      {(a) =>
        state.unreadable ? (
          <div className="space-y-1.5" data-testid="ai-key-unreadable">
            <p role="alert" className="text-xs text-destructive-ink">
              {t("ai.key.unreadable", { provider: name })}
            </p>
            {keyForm(a)}
          </div>
        ) : state.hasKey && !state.confirmed ? (
          <div className="space-y-1.5 text-sm" data-testid="ai-key-unconfirmed">
            <p role="alert" className="text-xs text-destructive-ink">
              {state.host ? t("ai.key.unconfirmed", { origin: state.origin ?? "", host: state.host }) : t("ai.key.unconfirmedOther", { origin: state.origin ?? "" })}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="xs" data-testid="ai-key-confirm" onClick={() => void client.call("ai.confirmKey", { provider, preset }).then((next) => setApp({ settings: reconcileSettings(next) }), (e: unknown) => snack.error(String(e)))}>
                {t("ai.key.confirm")}
              </Button>
              <Button variant="ghost" size="xs" aria-label={t("ai.key.remove", { provider: name })} onClick={() => void saveKey("")}>
                {t("common.remove")}
              </Button>
            </div>
          </div>
        ) : state.hasKey ? (
          <div className="flex items-center gap-2 text-sm" data-testid="ai-key-saved">
            <span className="text-success-ink">{state.hint ? t("ai.key.savedHint", { hint: state.hint }) : t("ai.key.saved")}</span>
            <Button variant="ghost" size="xs" aria-label={t("ai.key.remove", { provider: name })} onClick={() => void saveKey("")}>
              {t("common.remove")}
            </Button>
          </div>
        ) : (
          keyForm(a)
        )
      }
    </SettingsRow>
  );
}

type Catalog = { providers: ProviderDescriptor[]; presets: PresetDescriptor[] };
type Discovery = { state: "idle" } | { state: "loading" } | { state: "done"; models: ModelInfo[] } | { state: "error"; message: string };

export function AiTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai } = settings;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const choice = choiceOf(ai);
  const presetNeedsKey = ai.provider === "compatible" && (catalog?.presets.find((p) => p.id === ai.preset)?.needsKey ?? ai.preset !== "custom");
  const descriptor = catalog?.providers.find((p) => p.id === ai.provider);
  const needsKey = ai.provider === "compatible" ? presetNeedsKey : (descriptor?.needsKey ?? false);
  const keyed = choice === "keys";
  // plan 168: one key row for a service of the user's choosing; Claude's and OpenAI's are both shown under `keys`
  const showsKey = !keyed && (needsKey || (ai.provider === "compatible" && choice === "compatible"));
  // plan 168: a model is chosen only where Terno can't know which exist: a server on this Mac or a compatible service
  const showsModel = LOCAL_CHOICES.includes(choice) || choice === "compatible";
  // any endpoint set is shown (an imported one included), so it can be seen and changed
  const showsEndpoint = LOCAL_CHOICES.includes(choice) || (ai.provider === "compatible" && (ai.preset === "custom" || ai.preset === "azure")) || Boolean(ai.baseURL);

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
      if (!/^https?:\/\/[^/\s]+/i.test(value)) return setEndpointError(t("ai.endpoint.invalid"));
      setEndpointError(null);
      update({ ai: { baseURL: value } }, { quiet: true }).catch((e) => setEndpointError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => clearTimeout(timer);
  }, [endpointDraft, endpoint, update]);

  // ── model discovery: when the tab opens and whenever provider or endpoint change (debounced)
  const [discovery, setDiscovery] = useState<Discovery>({ state: "idle" });
  const discoverySeq = useRef(0);
  const canDiscover = !ai.fromEnv && showsModel && (!needsKey || (ai.hasKey && ai.keyConfirmed));
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

  // ── test connection: a result only counts for the exact target it tested. On keys, each saved key with the model
  // drafting would run on there (plan 168); otherwise the provider as set up.
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<{ provider: AiProviderId; result: AiTestResult }[] | null>(null);
  const testSeq = useRef(0);
  const target = targetKey(ai);
  useEffect(() => {
    testSeq.current++;
    setTests(null);
    setTesting(false);
  }, [target]);
  const testTargets = keyed
    ? KEYED.filter((p) => keyStateOf(ai, p).hasKey).map((p) => ({ provider: p as AiProviderId, model: keyedModel(p), baseURL: ai.profiles[p]?.baseURL, preset: undefined }))
    : [{ provider: ai.provider, model: ai.model, baseURL: ai.baseURL ?? undefined, preset: ai.preset ?? undefined }];
  const runTest = async () => {
    const seq = ++testSeq.current;
    setTesting(true);
    try {
      const results = await Promise.all(testTargets.map(async (asked) => ({ provider: asked.provider, result: await client.call("ai.test", asked) })));
      // the user may have switched provider or key meanwhile: a late answer must not touch the new one
      if (seq !== testSeq.current) return;
      setTests(results);
      const capabilities = !keyed && results[0]?.result.ok ? results[0].result.capabilities : undefined;
      if (capabilities) {
        setApp((state) => (state.settings && targetKey(state.settings.ai) === target ? { settings: { ...state.settings, ai: { ...state.settings.ai, capabilities } } } : {}));
      }
    } finally {
      if (seq === testSeq.current) setTesting(false);
    }
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
      } else if (value === "keys") {
        // which of the two is stored decides nothing (plan 168); the one with a key reads best in an error
        await update({ ai: { provider: ai.keys.openai?.hasKey && !ai.keys.anthropic?.hasKey ? "openai" : "anthropic" } });
      } else {
        await update({ ai: { provider: value } });
      }
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };

  const selectable = (c: ProviderChoice) => c !== "fake" || catalog?.providers.some((p) => p.id === "fake");
  const items = [...LOCAL_CHOICES, ...CLOUD_CHOICES, "fake" as const, "none" as const].filter(selectable).map((c) => ({ value: c, label: choiceLabel(c) }));
  const models = discovery.state === "done" ? discovery.models : [];

  // plan 133 §7: a page of its own; leaving the tab comes back to the tab
  const stylePage = useAiDraftUi((s) => s.stylePage);
  useEffect(() => () => useAiDraftUi.setState({ stylePage: false }), []);
  if (stylePage) return <WritingStyle />;

  const features = (
    <>
      <DraftingGroup settings={settings} update={update} />
      <SummariesGroup settings={settings} update={update} />
      <AskGroup settings={settings} update={update} />
      <FollowupsGroup settings={settings} update={update} />
      {aiFeaturesAvailable(settings) && <DigestGroup settings={settings} update={update} />}
      <AiUseGroup settings={settings} update={update} />
    </>
  );
  // plan 146: what's below would write settings the overlay hides, and look stuck
  if (ai.fromEnv) {
    return (
      <div data-testid="ai-tab">
        <SettingsGroup footer={<PrivacyNote testId="ai-privacy" title={t("ai.privacy")}>{disclosureLine(ai)}</PrivacyNote>}>
          <SettingsRow label={t("settings.dev.aiNote")} hint={t("settings.dev.aiNote.hint")} testId="ai-dev-note">
            {() => (
              <Button variant="outline" size="sm" data-testid="ai-dev-open" onClick={() => openSettingsTab("dev")}>
                {t("settings.dev.open")}
              </Button>
            )}
          </SettingsRow>
          {routingLine(ai) && <SettingsNote testId="ai-routing">{routingLine(ai)}</SettingsNote>}
        </SettingsGroup>
        {features}
      </div>
    );
  }

  return (
    <div data-testid="ai-tab">
      <SettingsGroup
        footer={
          <PrivacyNote testId="ai-privacy" title={!keyed && ai.provider !== "none" && !ai.local && hostOf(ai) ? t("ai.privacyHost", { host: hostOf(ai)! }) : t("ai.privacy")}>
            {disclosureLine(ai)}
          </PrivacyNote>
        }
      >
        <SettingsRow label={t("ai.provider")} hint={t("ai.provider.hint")}>
          {({ id: _id, ...a }) => (
            <Select value={choice} onValueChange={(v) => void select(v as ProviderChoice)} items={items}>
              <SelectTrigger {...a} size="sm" className="w-56" data-testid="ai-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{t("ai.group.local")}</SelectLabel>
                  {LOCAL_CHOICES.map((c) => (
                    <SelectItem key={c} value={c} data-testid={`ai-choice-${c}`}>
                      {choiceLabel(c)}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{t("ai.group.cloud")}</SelectLabel>
                  {CLOUD_CHOICES.map((c) => (
                    <SelectItem key={c} value={c} data-testid={`ai-choice-${c}`}>
                      {choiceLabel(c)}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
                {selectable("fake") && (
                  <SelectItem value="fake" data-testid="ai-choice-fake">
                    {choiceLabel("fake")}
                  </SelectItem>
                )}
                <SelectItem value="none" data-testid="ai-choice-none">
                  {choiceLabel("none")}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </SettingsRow>

        {ai.provider === "compatible" && choice === "compatible" && (
          <SettingsRow label={t("ai.service")}>
            {({ id: _id, ...a }) => (
              <Select
                value={ai.preset ?? "openrouter"}
                onValueChange={(v) => void update({ ai: { preset: v as CompatiblePreset, baseURL: null } })}
                items={PRESETS.map((p) => ({ value: p, label: presetLabel(p) }))}
              >
                <SelectTrigger {...a} size="sm" className="w-56" data-testid="ai-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {presetLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        )}

        {showsEndpoint && (
          <SettingsRow
            stacked
            labelFor
            label={ai.preset === "azure" ? t("ai.endpoint.azure") : t("ai.endpoint")}
            hint={ai.preset === "azure" ? t("ai.endpoint.azureHint", { url: `https://<${t("ai.endpoint.azureResource")}>.openai.azure.com` }) : undefined}
            error={endpointError}
            errorTestId="ai-endpoint-error"
          >
            {(a) => (
              <Input
                {...a}
                data-testid="ai-endpoint"
                className="h-7 bg-background font-mono text-xs dark:bg-input/30"
                value={endpointDraft}
                placeholder={ai.preset === "azure" ? t("ai.endpoint.azurePlaceholder") : (DEFAULT_ENDPOINT[choice] ?? PRESET_ENDPOINT[ai.preset ?? "custom"] ?? "http://127.0.0.1:8080/v1")}
                onChange={(e) => setEndpointDraft(e.target.value)}
              />
            )}
          </SettingsRow>
        )}

        {showsKey && <KeyRow ai={ai} provider={ai.provider} label={t(needsKey ? "ai.key.label" : "ai.key.labelOptional", { provider: providerName(ai) })} name={providerName(ai)} placeholder="sk-…" testId="ai-key" />}

        {/* plan 168: either key, or both; Terno picks the model for each feature, and says in one line who runs what */}
        {keyed && (
          <>
            <KeyRow ai={ai} provider="anthropic" label={t("ai.key.label", { provider: providerLabel("anthropic") })} name={providerLabel("anthropic")} placeholder="sk-ant-…" testId="ai-key-anthropic" />
            <KeyRow ai={ai} provider="openai" label={t("ai.key.label", { provider: providerLabel("openai") })} name={providerLabel("openai")} placeholder="sk-…" testId="ai-key-openai" />
            <SettingsNote testId="ai-routing">{routingLine(ai) ?? t("ai.keys.hint")}</SettingsNote>
          </>
        )}

        {showsModel && (
          <SettingsRow stacked labelFor label={t("ai.model")} hint={needsKey && !ai.hasKey ? t("ai.model.needsKey") : undefined}>
            {(a) => (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    {...a}
                    key={`${ai.provider}:${ai.model}`}
                    data-testid="ai-model"
                    className="h-7 bg-background font-mono text-xs dark:bg-input/30"
                    defaultValue={ai.model}
                    placeholder={choice === "ollama" ? "qwen3:8b" : t("ai.model.placeholder")}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value !== ai.model) void update({ ai: { model: value } });
                    }}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
                  <Button variant="outline" size="icon-sm" aria-label={t("ai.model.refresh")} disabled={!canDiscover} loading={discovery.state === "loading"} onClick={() => void discover()}>
                    <RefreshCw />
                  </Button>
                </div>
                {discovery.state === "error" && (
                  <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive-ink" data-testid="ai-discovery-error">
                    <CircleAlert className="size-3.5" aria-hidden /> {discovery.message}
                  </p>
                )}
                {models.length > 0 && (
                  <ul className="hairline-divide max-h-40 overflow-y-auto rounded-lg bg-background dark:bg-input/30" data-testid="ai-models" aria-label={t("ai.model.available")}>
                    {models.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          data-testid="ai-model-option"
                          data-selected={m.id === ai.model || undefined}
                          aria-pressed={m.id === ai.model}
                          onClick={() => void update({ ai: { model: m.id } })}
                          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset data-selected:bg-accent data-selected:text-accent-foreground"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">{m.label ? refText(m.label) : m.id}</span>
                          {m.loaded && <span className="rounded bg-success/15 px-1 text-2xs text-success-ink">{t("ai.model.loaded")}</span>}
                          {/* i18n-ignore: "32k ctx" is the context-window unit model servers print, the same in every language */}
                          {m.contextTokens ? <span className="text-muted-foreground tabular">{Math.round(m.contextTokens / 1024)}k ctx</span> : null}
                          {m.sizeBytes ? <span className="text-muted-foreground tabular">{formatBytes(m.sizeBytes)}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </SettingsRow>
        )}

        {ai.provider !== "none" && (
          <div className="space-y-2 py-3">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" data-testid="ai-test" disabled={keyed ? testTargets.length === 0 : ai.provider !== "fake" && !ai.model} loading={testing} onClick={() => void runTest()}>
                {t("ai.test")}
              </Button>
              <span role="status" aria-live="polite" className="flex flex-col gap-0.5 text-xs">
                {tests?.map(({ provider, result }) =>
                  result.ok ? (
                    <span key={provider} className="flex items-center gap-1.5 text-success-ink" data-testid="ai-test-result">
                      <CircleCheck className="size-3.5" aria-hidden /> {tests.length > 1 && `${providerLabel(provider)}: `}
                      {t("ai.test.connected")} · <span data-testid="ai-test-latency">{result.latencyMs} ms</span> · {t(OUTPUT_LABEL[result.capabilities!.output])}
                    </span>
                  ) : null,
                )}
                {!tests && !keyed && ai.capabilities?.probedAt && <span className="text-muted-foreground">{t("ai.test.last", { output: t(OUTPUT_LABEL[ai.capabilities.output]) })}</span>}
              </span>
            </div>
            {tests?.map(({ provider, result }) =>
              result.warning ? (
                <p key={provider} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="ai-test-warning">
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden /> {localized(result.warning, result.warningI18n)}
                </p>
              ) : null,
            )}
            {tests?.map(({ provider, result }) =>
              result.ok ? null : (
                <div key={provider} role="alert" className="text-xs" data-testid="ai-test-error">
                  <p className="text-destructive-ink">
                    {tests.length > 1 && `${providerLabel(provider)}: `}
                    {localized(result.error?.message, result.error?.i18n)}
                  </p>
                  {errorHelp(result.error?.kind, { provider, preset: provider === ai.provider ? ai.preset : null, local: provider === ai.provider && ai.local }) && <p className="mt-0.5 text-muted-foreground">{errorHelp(result.error?.kind, { provider, preset: provider === ai.provider ? ai.preset : null, local: provider === ai.provider && ai.local })}</p>}
                </div>
              ),
            )}
          </div>
        )}
      </SettingsGroup>
      {features}
    </div>
  );
}
