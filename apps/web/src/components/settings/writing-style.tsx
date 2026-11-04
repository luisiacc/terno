import type { Habits, VoiceJudgment, WritingProfileView, WritingStatus, WritingStudyResult } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Spinner } from "@terno/ui/components/spinner";
import { Textarea } from "@terno/ui/components/textarea";
import { ChevronLeft } from "@terno/ui/icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { providerLabel } from "~/lib/ai";
import { useAiDraftUi } from "~/lib/ai-draft-state";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { ConfirmDialog, SettingsGroup, SettingsNote, SettingsRow } from "./parts";

/**
 * Plan 133 §7: Settings → AI → Writing style, a lazy page. What Terno has worked out, in plain words: nothing here is a
 * prompt to read, and everything can be edited, reset or rebuilt. Editing pins a profile; a later pass offers "Update".
 */

const failed = (e: unknown): void => { snack.error(e instanceof Error ? e.message : String(e)); };

/** "yesterday", "3 days ago": days are what a status like this needs. */
function dayAgo(ms: number): string {
  const days = Math.round((Date.now() - ms) / 86_400_000);
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(-days, "day");
}

const shown = (text: string) => text.replace(/\{name\}/g, "…");

/** The counts as sentences. */
export function habitLines(h: Habits): string[] {
  const lines: string[] = [];
  if (h.words.median > 0) lines.push(t("aiDraft.style.length", { count: h.words.median }));
  const greeting = h.greetings[0];
  // "{name}," alone is someone who opens with just the name: said in words, not as a lone mark in quotes
  if (greeting && greeting.share >= 0.15) lines.push(/^\{name\}\W*$/.test(greeting.text) ? t("aiDraft.style.greetingName") : t("aiDraft.style.greeting", { text: shown(greeting.text) }));
  else if (h.noGreeting >= 0.6) lines.push(t("aiDraft.style.noGreeting"));
  const signOff = h.signOffs[0];
  if (signOff && signOff.share >= 0.15) lines.push(t("aiDraft.style.signOff", { text: shown(signOff.text) }));
  else if (h.noSignOff >= 0.6) lines.push(t("aiDraft.style.noSignOff"));
  if (h.exclamation >= 0.3) lines.push(t("aiDraft.style.exclamationOften"));
  else if (h.exclamation <= 0.05) lines.push(t("aiDraft.style.exclamationRare"));
  if (h.emoji >= 0.1) lines.push(t("aiDraft.style.emoji"));
  if (h.lowercase >= 0.5) lines.push(t("aiDraft.style.lowercase"));
  if (h.bullets >= 0.2) lines.push(t("aiDraft.style.bullets"));
  return lines;
}

const SCALES = { formality: ["aiDraft.trait.formality1", "aiDraft.trait.formality2", "aiDraft.trait.formality3", "aiDraft.trait.formality4", "aiDraft.trait.formality5"], warmth: ["aiDraft.trait.warmth1", "aiDraft.trait.warmth2", "aiDraft.trait.warmth3", "aiDraft.trait.warmth4", "aiDraft.trait.warmth5"], directness: ["aiDraft.trait.direct1", "aiDraft.trait.direct2", "aiDraft.trait.direct3", "aiDraft.trait.direct4", "aiDraft.trait.direct5"] } as const;

/** The model's scales as words, when it has studied them (§3). */
function traitLine(j: VoiceJudgment): string {
  const at = (scale: keyof typeof SCALES, value: number) => t(SCALES[scale][Math.max(1, Math.min(5, value)) - 1]!);
  return [at("formality", j.traits.formality), at("warmth", j.traits.warmth), at("directness", j.traits.directness)].join(", ");
}

const scopeTitle = (p: WritingProfileView, accounts: readonly { id: number; displayName: string; email: string }[]): string => {
  if (p.scope === "you") return t("aiDraft.style.you");
  const [, id, rest] = p.scopeKey.split(":");
  const account = accounts.find((a) => a.id === Number(id));
  if (p.scope === "account") return account?.displayName || account?.email || t("aiDraft.style.anAccount");
  return p.scopeKey.split(":").slice(2).join(":") || rest || "";
};

const asLines = (items: readonly { text: string }[] | readonly string[]) => items.map((i) => (typeof i === "string" ? i : i.text)).join("\n");
const fromLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function ProfileEditor({ p, onDone }: { p: WritingProfileView; onDone: (next: WritingProfileView | null) => void }) {
  const ids = useId();
  const [greetings, setGreetings] = useState(asLines(p.habits.greetings));
  const [signOffs, setSignOffs] = useState(asLines(p.habits.signOffs));
  const [phrases, setPhrases] = useState(asLines(p.phrases));
  const [notes, setNotes] = useState(asLines(p.judgment?.notes ?? []));
  const shares = (list: readonly { text: string; share: number }[], text: string) => fromLines(text).slice(0, 10).map((line) => ({ text: line, share: list.find((i) => i.text === line)?.share ?? 0.1 }));
  const save = async () => {
    try {
      const next = await client.call("writing.profiles.edit", {
        scopeKey: p.scopeKey,
        language: p.language,
        greetings: shares(p.habits.greetings, greetings),
        signOffs: shares(p.habits.signOffs, signOffs),
        phrases: fromLines(phrases).slice(0, 40),
        ...(p.judgment ? { judgment: { traits: p.judgment.traits, notes: fromLines(notes).slice(0, 8) } } : {}),
      });
      onDone(next);
    } catch (e) {
      failed(e);
    }
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void, testId: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${id}`} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Textarea id={`${ids}-${id}`} data-testid={testId} value={value} onChange={(e) => set(e.target.value)} className="min-h-14 bg-background dark:bg-input/30" />
    </div>
  );
  return (
    <div className="flex flex-col gap-2.5" data-testid="style-editor">
      {field("greetings", t("aiDraft.style.editGreetings"), greetings, setGreetings, "style-edit-greetings")}
      {field("signoffs", t("aiDraft.style.editSignOffs"), signOffs, setSignOffs, "style-edit-signoffs")}
      {field("phrases", t("aiDraft.style.editPhrases"), phrases, setPhrases, "style-edit-phrases")}
      {p.judgment && field("notes", t("aiDraft.style.editNotes"), notes, setNotes, "style-edit-notes")}
      <div className="flex gap-1.5">
        <Button size="sm" data-testid="style-edit-save" onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="sm" variant="ghost" data-testid="style-edit-cancel" onClick={() => onDone(null)}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

function Profile({ initial, onChanged }: { initial: WritingProfileView; onChanged: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const [p, setP] = useState(initial);
  const [editing, setEditing] = useState(false);
  // a pass finished or a reset landed: the row follows, unless someone is editing it
  const [read, setRead] = useState(initial);
  if (initial !== read && !editing) {
    setRead(initial);
    setP(initial);
  }
  const language = p.language ? new Intl.DisplayNames([getLocale()], { type: "language" }).of(p.language) : null;
  const title = language ? `${scopeTitle(p, accounts)} · ${language}` : scopeTitle(p, accounts);
  const lines = habitLines(p.habits);
  const reset = () => {
    void client.call("writing.profiles.reset", { scopeKey: p.scopeKey, language: p.language }).then(onChanged, failed);
  };
  return (
    <SettingsRow
      stacked
      label={<span className="flex items-center gap-1.5" data-testid="style-profile-title">{title}{p.edited && <Badge variant="secondary" data-testid="style-profile-edited">{t("aiDraft.style.edited")}</Badge>}</span>}
      hint={t("aiDraft.style.from", { count: p.samples })}
      testId="style-profile"
    >
      {() =>
        editing ? (
          <ProfileEditor p={p} onDone={(next) => { setEditing(false); if (next) setP(next); }} />
        ) : (
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-0.5 text-sm" data-testid="style-profile-lines">
              {lines.map((line) => <li key={line}>{line}</li>)}
              {p.phrases.length > 0 && <li data-testid="style-profile-phrases">{t("aiDraft.style.phrases", { phrases: p.phrases.slice(0, 5).map((x) => `“${x}”`).join(", ") })}</li>}
              {p.judgment && <li>{traitLine(p.judgment)}</li>}
              {p.judgment?.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
            <div className="-ml-2 flex flex-wrap gap-0.5">
              <Button size="xs" variant="ghost" className="font-normal" data-testid="style-profile-edit" onClick={() => setEditing(true)}>{t("common.edit")}</Button>
              {p.edited && p.newSince > 0 ? (
                <Button size="xs" variant="ghost" className="font-normal" data-testid="style-profile-update" onClick={reset}>{t("aiDraft.style.update", { count: p.newSince })}</Button>
              ) : (
                <Button size="xs" variant="ghost" className="font-normal" data-testid="style-profile-reset" onClick={reset}>{t("common.reset")}</Button>
              )}
            </div>
          </div>
        )
      }
    </SettingsRow>
  );
}

const PAGE = 50;

/** Domains and people, read when they're opened: there can be many. */
function Section({ scope, title, testId, version, onChanged }: { scope: "domain" | "person"; title: string; testId: string; version: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WritingProfileView[] | null>(null);
  const [next, setNext] = useState<{ scopeKey: string; language: string } | null>(null);
  const read = useCallback(async (after: { scopeKey: string; language: string } | null) => {
    const page = await client.call("writing.profiles.list", { scope, limit: PAGE, ...(after ? { after } : {}) });
    setItems((held) => (after ? [...(held ?? []), ...page.items] : page.items));
    setNext(page.next);
  }, [scope]);
  useEffect(() => {
    if (open) void read(null).catch(failed);
  }, [open, read, version]);
  return (
    <section className="mb-6 last:mb-0" data-testid={testId}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="-mx-2 mb-1.5 h-7 w-[calc(100%+1rem)] rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground" data-testid={`${testId}-toggle`}>
          {title}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="hairline-divide rounded-[calc(var(--radius-lg)+2px)] bg-tint px-4">
            {items === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : items.length === 0 ? <SettingsNote testId={`${testId}-empty`}>{t(scope === "domain" ? "aiDraft.style.noDomains" : "aiDraft.style.noPeople")}</SettingsNote> : items.map((p) => <Profile key={`${p.scopeKey}|${p.language}`} initial={p} onChanged={onChanged} />)}
          </div>
          {next && (
            <Button variant="link-secondary" className="mt-1.5 ml-1 text-xs" data-testid={`${testId}-more`} onClick={() => void read(next).catch(failed)}>
              {t("aiDraft.style.more")}
            </Button>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

type StudyState = { kind: "idle" } | { kind: "asking" } | { kind: "consent"; asked: Extract<WritingStudyResult, { status: "consent" }> } | { kind: "running"; requestId: string; done: number; total: number } | { kind: "done" } | { kind: "failed" } | { kind: "nothing" };

/** "Let AI study my style": optional, and said in full before anything goes (§4). */
function Study({ status, onChanged }: { status: WritingStatus | null; onChanged: () => void }) {
  const ai = useApp((s) => s.settings?.ai);
  const [state, setState] = useState<StudyState>({ kind: "idle" });
  // listening before asking: on a local model the study can be over before the call that started it has answered
  const asking = useRef<string | null>(null);
  useEffect(() => client.on("aiStudy", (p) => {
    if (p.requestId !== asking.current) return;
    if (p.state === "running") return setState({ kind: "running", requestId: p.requestId, done: p.done, total: p.total });
    asking.current = null;
    setState({ kind: p.state === "done" ? "done" : p.state === "failed" ? "failed" : "idle" });
    if (p.state === "done") onChanged();
  }), [onChanged]);
  const ask = async () => {
    setState({ kind: "asking" });
    try {
      const id = globalThis.crypto.randomUUID();
      asking.current = id;
      const asked = await client.call("writing.studyStyle", { requestId: id });
      if (asked.status === "consent") setState({ kind: "consent", asked });
      else if (asked.status === "nothing") setState({ kind: "nothing" });
      // a local provider asks nothing: it's running, with its progress and Stop like any other
      else if (asking.current === id) setState({ kind: "running", requestId: id, done: 0, total: asked.total });
    } catch (e) {
      failed(e);
      setState({ kind: "idle" });
    }
  };
  const confirm = async (asked: Extract<WritingStudyResult, { status: "consent" }>) => {
    const id = globalThis.crypto.randomUUID();
    asking.current = id;
    setState({ kind: "running", requestId: id, done: 0, total: asked.messages });
    try {
      const started = await client.call("writing.studyStyle", { requestId: id, confirm: { provider: asked.provider, accountIds: asked.accountIds } });
      if (started.status === "started") { if (asking.current === id) setState({ kind: "running", requestId: id, done: 0, total: started.total }); }
      else setState({ kind: started.status === "nothing" ? "nothing" : "idle" });
    } catch (e) {
      failed(e);
      setState({ kind: "idle" });
    }
  };
  return (
    <SettingsGroup title={t("aiDraft.study.title")} testId="style-study">
      {state.kind === "consent" ? (
        <div className="py-3 text-sm" data-testid="style-study-consent">
          <p className="font-medium">{t("aiDraft.study.question")}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("aiDraft.study.consent", { count: state.asked.messages, provider: ai ? providerLabel(state.asked.provider, ai) : state.asked.provider })}{" "}
            {t("aiDraft.study.tokens", { tokens: state.asked.tokens.toLocaleString(getLocale()) })}
            {state.asked.usd !== null ? ` ${t("aiDraft.study.cost", { usd: new Intl.NumberFormat(getLocale(), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(state.asked.usd) })}` : ""}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("aiDraft.study.drafts")}</p>
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" data-testid="style-study-confirm" onClick={() => void confirm(state.asked)}>{t("aiDraft.study.confirm")}</Button>
            <Button size="sm" variant="ghost" data-testid="style-study-decline" onClick={() => setState({ kind: "idle" })}>{t("aiDraft.study.decline")}</Button>
          </div>
        </div>
      ) : (
        <SettingsRow label={t("aiDraft.study.action")} hint={status?.study ? t("aiDraft.study.agreed", { provider: ai ? providerLabel(status.study.provider as never, ai) : status.study.provider }) : t("aiDraft.study.hint")} testId="style-study-row">
          {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) =>
            state.kind === "running" ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="style-study-running">
                <Spinner aria-hidden className="size-[1.15em]" />
                {t("aiDraft.study.running", { done: state.done, total: state.total })}
                <Button size="xs" variant="ghost" className="font-normal" data-testid="style-study-stop" onClick={() => void client.call("ai.cancel", { requestId: state.requestId }).catch(() => {})}>{t("aiDraft.stop")}</Button>
              </span>
            ) : (
              <Button variant="outline" size="sm" aria-describedby={described} loading={state.kind === "asking"} data-testid="style-study-start" onClick={() => void ask()}>
                {t("aiDraft.study.start")}
              </Button>
            )
          }
        </SettingsRow>
      )}
      {state.kind === "done" && <SettingsNote testId="style-study-done">{t("aiDraft.study.done")}</SettingsNote>}
      {state.kind === "failed" && <SettingsNote testId="style-study-failed"><span role="status" className="text-destructive-ink">{t("aiDraft.study.failed")}</span></SettingsNote>}
      {state.kind === "nothing" && <SettingsNote testId="style-study-nothing">{t("aiDraft.study.nothing")}</SettingsNote>}
    </SettingsGroup>
  );
}

export default function WritingStyle() {
  const [own, setOwn] = useState<WritingProfileView[] | null>(null);
  const [status, setStatus] = useState<WritingStatus | null>(null);
  const [version, setVersion] = useState(0);
  const [clearing, setClearing] = useState(false);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let current = true;
    void (async () => {
      const [you, accounts] = await Promise.all([client.call("writing.profiles.list", { scope: "you", limit: 20 }), client.call("writing.profiles.list", { scope: "account", limit: 100 })]);
      if (!current) return;
      setOwn([...you.items, ...accounts.items]);
      setStatus(accounts.status);
    })().catch(failed);
    return () => { current = false; };
  }, [version]);
  // there's no event for a pass finishing: while this page is open and one is due or running, it looks again, for a while
  const learning = status?.state === "learning" || status?.state === "idle";
  useEffect(() => {
    if (!learning || version >= 60) return;
    const timer = setTimeout(changed, 2000);
    return () => clearTimeout(timer);
  }, [learning, version, changed]);
  const line = !status ? "" : status.state === "off" ? t("aiDraft.style.off") : status.state === "ready" && status.messages > 0 && status.updatedAt !== null ? t("aiDraft.style.learned", { count: status.messages, when: dayAgo(status.updatedAt) }) : status.state === "learning" ? t("aiDraft.style.learning") : t("aiDraft.style.idle");
  return (
    <div data-testid="writing-style">
      <Button variant="link-secondary" className="mb-3 ml-1 text-xs" data-testid="writing-style-back" onClick={() => useAiDraftUi.setState({ stylePage: false })}>
        <ChevronLeft /> {t("aiDraft.settings.title")}
      </Button>
      <SettingsGroup title={t("aiDraft.style.title")} testId="style-own" footer={<span data-testid="style-status">{line}</span>}>
        {own === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : own.length === 0 ? <SettingsNote testId="style-empty">{t("aiDraft.style.empty")}</SettingsNote> : own.map((p) => <Profile key={`${p.scopeKey}|${p.language}`} initial={p} onChanged={changed} />)}
      </SettingsGroup>
      <Section scope="domain" title={t("aiDraft.style.domains")} testId="style-domains" version={version} onChanged={changed} />
      <Section scope="person" title={t("aiDraft.style.people")} testId="style-people" version={version} onChanged={changed} />
      <Study status={status} onChanged={changed} />
      <SettingsGroup testId="style-actions">
        <SettingsRow label={t("aiDraft.style.rebuild")} hint={t("aiDraft.style.rebuildHint")}>
          {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) => (
            <Button variant="outline" size="sm" aria-describedby={described} data-testid="style-rebuild" onClick={() => void client.call("writing.profiles.rebuild", {}).then(changed, failed)}>
              {t("aiDraft.style.rebuildButton")}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label={t("aiDraft.style.clear")} hint={t("aiDraft.style.clearHint")}>
          {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) => (
            <Button variant="ghost" size="sm" className="text-destructive-ink" aria-describedby={described} data-testid="style-clear" onClick={() => setClearing(true)}>
              {t("aiDraft.style.clearButton")}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title={t("aiDraft.style.clearTitle")} description={t("aiDraft.style.clearHint")} confirm={t("aiDraft.style.clearButton")} testId="style-clear-dialog" onConfirm={() => client.call("writing.profiles.clear", {}).then(changed, failed)} />
    </div>
  );
}
