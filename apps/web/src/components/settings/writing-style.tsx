import type { Habits, VoiceJudgment, WritingProfileView, WritingStatus, WritingStudyResult } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { CloseButton } from "@terno/ui/components/close-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Spinner } from "@terno/ui/components/spinner";
import { Textarea } from "@terno/ui/components/textarea";
import { Plus } from "@terno/ui/icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { providerLabel } from "~/lib/ai";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { ConfirmDialog, SettingsGroup, SettingsNote, SettingsRow } from "./parts";

/**
 * Plan 133 §7: Settings → AI → Writing style. What Terno has worked out, in plain words: nothing here is a
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
/** plan 161: a greeting or sign-off is an item, its own line breaks kept ("Cheers," and "Luis" are one sign-off) */
const fromItems = (items: readonly string[]) => items.map((i) => i.split("\n").map((l) => l.trimEnd()).join("\n").trim()).filter(Boolean);
const ITEMS_MAX = 10;

/** Plan 161: a list of short texts, each its own field, with remove and Add. */
function ItemsField({ label, add, item, remove, items, onChange, testId, first }: { label: string; add: string; item: (n: number) => string; remove: (n: number) => string; items: string[]; onChange: (items: string[]) => void; testId: string; first?: React.Ref<HTMLTextAreaElement> }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5" data-testid={testId}>
      <p id={id} className="text-xs font-medium text-muted-foreground">{label}</p>
      {items.map((value, i) => (
        <div key={i} className="flex items-start gap-1" data-testid={`${testId}-item`}>
          <Textarea ref={i === 0 ? first : undefined} aria-label={item(i + 1)} data-testid={`${testId}-field`} value={value} rows={1} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} className="min-h-9 resize-none py-1.5" />
          <CloseButton label={remove(i + 1)} className="mt-1.5" data-testid={`${testId}-remove`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      {items.length < ITEMS_MAX && (
        <Button size="xs" variant="ghost" className="-ml-2 self-start font-normal text-muted-foreground" data-testid={`${testId}-add`} onClick={() => onChange([...items, ""])}>
          <Plus /> {add}
        </Button>
      )}
    </div>
  );
}

function ProfileEditor({ p, title, onDone }: { p: WritingProfileView; title: string; onDone: (next: WritingProfileView | null) => void }) {
  const ids = useId();
  const [greetings, setGreetings] = useState(() => p.habits.greetings.map((g) => g.text));
  const [signOffs, setSignOffs] = useState(() => p.habits.signOffs.map((g) => g.text));
  const [phrases, setPhrases] = useState(asLines(p.phrases));
  const [notes, setNotes] = useState(asLines(p.judgment?.notes ?? []));
  const first = useRef<HTMLTextAreaElement>(null);
  const phrasesRef = useRef<HTMLTextAreaElement>(null);
  // plan 161: editing starts in its first field
  useEffect(() => {
    (first.current ?? phrasesRef.current)?.focus({ preventScroll: true });
  }, []);
  const shares = (list: readonly { text: string; share: number }[], items: readonly string[]) => fromItems(items).slice(0, ITEMS_MAX).map((text) => ({ text, share: list.find((i) => i.text === text)?.share ?? 0.1 }));
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
  const field = (id: string, label: string, value: string, set: (v: string) => void, testId: string, ref?: React.Ref<HTMLTextAreaElement>) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${id}`} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Textarea ref={ref} id={`${ids}-${id}`} data-testid={testId} value={value} onChange={(e) => set(e.target.value)} className="min-h-14" />
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="style-editor" aria-label={t("aiDraft.style.editing", { name: title })} role="group">
      <ItemsField label={t("aiDraft.style.editGreetings")} add={t("aiDraft.style.addGreeting")} item={(n) => t("aiDraft.style.greetingItem", { n })} remove={(n) => t("aiDraft.style.removeGreeting", { n })} items={greetings} onChange={setGreetings} testId="style-edit-greetings" first={first} />
      <ItemsField label={t("aiDraft.style.editSignOffs")} add={t("aiDraft.style.addSignOff")} item={(n) => t("aiDraft.style.signOffItem", { n })} remove={(n) => t("aiDraft.style.removeSignOff", { n })} items={signOffs} onChange={setSignOffs} testId="style-edit-signoffs" />
      {field("phrases", t("aiDraft.style.editPhrases"), phrases, setPhrases, "style-edit-phrases", greetings.length ? undefined : phrasesRef)}
      {p.judgment && field("notes", t("aiDraft.style.editNotes"), notes, setNotes, "style-edit-notes")}
      {/* plan 161: as Rules' footer, Save and Cancel stay in view however tall the form is */}
      <div className="sticky -bottom-4 z-10 -mx-4 -mb-3 flex gap-1.5 border-t border-hairline bg-popover bg-linear-to-b from-(--card-bg) to-(--card-bg) px-4 pt-2.5 pb-6.5" data-testid="style-edit-footer">
        <Button size="sm" data-testid="style-edit-save" onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="sm" variant="ghost" data-testid="style-edit-cancel" onClick={() => onDone(null)}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

/** A scope with rows per language doesn't also show the row that merges them. */
function oncePerScope<T extends { scopeKey: string; language: string }>(items: readonly T[]): T[] {
  const split = new Set(items.filter((p) => p.language).map((p) => p.scopeKey));
  return items.filter((p) => p.language || !split.has(p.scopeKey));
}

/** A profile's name: whose, then its language. */
function useProfileTitle(p: WritingProfileView): string {
  const accounts = useApp((s) => s.accounts);
  const language = p.language ? new Intl.DisplayNames([getLocale()], { type: "language" }).of(p.language) : null;
  return language ? `${scopeTitle(p, accounts)} · ${language}` : scopeTitle(p, accounts);
}

/** Plan 161: a reset, undoable where it happened (a snack would sit behind Settings, out of reach: Codex review) */
type ResetDone = { name: string; undo: string };

function Profile({ initial, onChanged, onEditing, onReset }: { initial: WritingProfileView; onChanged: () => void; /** plan 161 (Codex review): the picker waits while it's edited */ onEditing?: (editing: boolean) => void; onReset: (done: ResetDone) => void }) {
  const [p, setP] = useState(initial);
  const [editing, setEditingState] = useState(false);
  const setEditing = (on: boolean) => {
    setEditingState(on);
    onEditing?.(on);
  };
  const editButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // after Save or Cancel, back where the edit began (plan 161): its Edit button, in view
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (!back || editing) return;
    setBack(false);
    card.current?.scrollIntoView({ block: "nearest" });
    editButton.current?.focus({ preventScroll: true });
  }, [back, editing]);
  // a pass finished or a reset landed: the row follows, unless someone is editing it
  const [read, setRead] = useState(initial);
  if (initial !== read && !editing) {
    setRead(initial);
    setP(initial);
  }
  const title = useProfileTitle(p);
  const lines = habitLines(p.habits);
  const examples = p.phrases.length + (p.judgment?.notes.length ?? 0);
  const reset = () => {
    void client.call("writing.profiles.reset", { scopeKey: p.scopeKey, language: p.language }).then((r) => {
      onChanged();
      // plan 161: as other removals, said, with its Undo
      onReset({ name: title, undo: r.undo });
    }, failed);
  };
  return (
    <div ref={card} className="scroll-my-12">
      <SettingsRow
        stacked
        label={<span className="flex items-center gap-1.5" data-testid="style-profile-title">{title}{p.edited && <Badge variant="secondary" data-testid="style-profile-edited">{t("aiDraft.style.edited")}</Badge>}</span>}
        hint={t("aiDraft.style.from", { count: p.samples })}
        testId="style-profile"
      >
        {() =>
          editing ? (
            <ProfileEditor p={p} title={title} onDone={(next) => { setEditing(false); setBack(true); if (next) setP(next); }} />
          ) : (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col gap-0.5 text-sm" data-testid="style-profile-lines">
                {lines.map((line) => <li key={line}>{line}</li>)}
                {p.judgment && <li>{traitLine(p.judgment)}</li>}
              </ul>
              {/* plan 161: the examples second, on request */}
              {examples > 0 && (
                <Collapsible>
                  <CollapsibleTrigger className="-ml-1 w-auto gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground" data-testid="style-profile-examples-toggle">
                    {t("aiDraft.style.examples", { count: examples })}
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <ul className="mt-1 flex flex-col gap-0.5 text-sm" data-testid="style-profile-examples">
                      {p.phrases.map((x) => <li key={`p${x}`} data-testid="style-profile-phrase">“{x}”</li>)}
                      {p.judgment?.notes.map((note) => <li key={`n${note}`}>{note}</li>)}
                    </ul>
                  </CollapsiblePanel>
                </Collapsible>
              )}
              <div className="-ml-2 flex flex-wrap gap-0.5">
                <Button ref={editButton} size="xs" variant="ghost" className="font-normal" aria-label={t("aiDraft.style.editName", { name: title })} data-testid="style-profile-edit" onClick={() => setEditing(true)}>{t("common.edit")}</Button>
                {p.edited && p.newSince > 0 ? (
                  <Button size="xs" variant="ghost" className="font-normal" data-testid="style-profile-update" onClick={reset}>{t("aiDraft.style.update", { count: p.newSince })}</Button>
                ) : (
                  <Button size="xs" variant="ghost" className="font-normal" aria-label={t("aiDraft.style.resetName", { name: title })} data-testid="style-profile-reset" onClick={reset}>{t("common.reset")}</Button>
                )}
              </div>
            </div>
          )
        }
      </SettingsRow>
    </div>
  );
}

const profileKey = (p: Pick<WritingProfileView, "scopeKey" | "language">) => `${p.scopeKey}|${p.language}`;

/** Plan 161: your own and your accounts' profiles, one at a time, picked by whose and which language. */
function OwnProfiles({ items, onChanged, onReset }: { items: WritingProfileView[]; onChanged: () => void; onReset: (done: ResetDone) => void }) {
  const accounts = useApp((s) => s.accounts);
  const list = oncePerScope(items);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const current = list.find((p) => profileKey(p) === chosen) ?? list[0]!;
  const label = (p: WritingProfileView) => {
    const language = p.language ? new Intl.DisplayNames([getLocale()], { type: "language" }).of(p.language) : null;
    return language ? `${scopeTitle(p, accounts)} · ${language}` : scopeTitle(p, accounts);
  };
  const options = list.map((p) => ({ value: profileKey(p), label: label(p) }));
  return (
    <>
      {list.length > 1 && (
        <div className="flex items-center justify-between gap-6 py-2.5">
          <label id="style-scope-label" className="text-sm font-medium">{t("aiDraft.style.showing")}</label>
          <Select value={profileKey(current)} onValueChange={(v) => setChosen(v as string)} items={options} disabled={editing}>
            <SelectTrigger size="sm" className="w-64" aria-labelledby="style-scope-label" data-testid="style-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={profileKey(p)} value={profileKey(p)}>
                  {label(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Profile key={profileKey(current)} initial={current} onChanged={onChanged} onEditing={setEditing} onReset={onReset} />
    </>
  );
}

const PAGE = 50;

/** Domains and people, read when they're opened: there can be many. */
function Section({ scope, title, testId, version, onChanged, onReset }: { scope: "domain" | "person"; title: string; testId: string; version: number; onChanged: () => void; onReset: (done: ResetDone) => void }) {
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
            {items === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : items.length === 0 ? <SettingsNote testId={`${testId}-empty`}>{t(scope === "domain" ? "aiDraft.style.noDomains" : "aiDraft.style.noPeople")}</SettingsNote> : oncePerScope(items).map((p) => <Profile key={`${p.scopeKey}|${p.language}`} initial={p} onChanged={onChanged} onReset={onReset} />)}
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
      const started = await client.call("writing.studyStyle", { requestId: id, confirm: { provider: asked.provider, destination: asked.destination, accountIds: asked.accountIds } });
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
  const [reset, setReset] = useState<ResetDone | null>(null);
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
      {/* plan 161: what it has learned, and how the styles combine, before any of them */}
      <div className="mb-4 px-1" data-testid="style-overview">
        <p className="text-sm" data-testid="style-status">{line}</p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="style-precedence">{t("aiDraft.style.precedence")}</p>
        {reset && (
          <p role="status" className="mt-2 flex items-center gap-2 text-sm" data-testid="style-reset-done">
            {t("aiDraft.style.resetDone", { name: reset.name })}
            <Button
              variant="link-secondary"
              size="xs"
              data-testid="style-reset-undo"
              aria-label={t("aiDraft.style.undoReset", { name: reset.name })}
              onClick={() => {
                setReset(null);
                void client.call("writing.profiles.restore", { undo: reset.undo }).then((r) => {
                  changed();
                  if (!r.restored) snack.error(t("aiDraft.style.undoGone"));
                }, failed);
              }}
            >
              {t("common.undo")}
            </Button>
          </p>
        )}
      </div>
      <SettingsGroup title={t("aiDraft.style.yours")} testId="style-own">
        {own === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : own.length === 0 ? <SettingsNote testId="style-empty">{t("aiDraft.style.empty")}</SettingsNote> : <OwnProfiles items={own} onChanged={changed} onReset={setReset} />}
      </SettingsGroup>
      <Section scope="domain" title={t("aiDraft.style.domains")} testId="style-domains" version={version} onChanged={changed} onReset={setReset} />
      <Section scope="person" title={t("aiDraft.style.people")} testId="style-people" version={version} onChanged={changed} onReset={setReset} />
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
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title={t("aiDraft.style.clearTitle")} description={t("aiDraft.style.clearHint")} confirm={t("aiDraft.style.clearButton")} testId="style-clear-dialog" onConfirm={() => client.call("writing.profiles.clear", {}).then(() => { setReset(null); changed(); }, failed)} />
    </div>
  );
}
