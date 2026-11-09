import type { Habits, VoiceJudgment, WritingProfileView, WritingStatus } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { richT } from "~/lib/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { CloseButton } from "@terno/ui/components/close-button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Spinner } from "@terno/ui/components/spinner";
import { Textarea } from "@terno/ui/components/textarea";
import { Plus } from "@terno/ui/icons";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { providerLabel } from "~/lib/ai";
import { snack } from "~/lib/snack";
import { imeKey } from "~/lib/ime-escape";
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
/** the share from which a draft's prompt carries a greeting or sign-off (core's render.ts `usage`) */
const DRAFT_SHARE = 0.1;

/**
 * The counts as sentences. Plan 162 (after ai162-r05): an edited profile's greeting and sign-off are what a draft will
 * use, the user's first one, said as a fact ("Opens with “Hi”"): the prompt carries one from 10% (render.ts), so a value
 * the user typed (10%, under the 15% a counted one needs) had vanished from the read view, leaving only "Edited".
 */
export function habitLines(h: Habits, edited = false): string[] {
  const lines: string[] = [];
  if (h.words.median > 0) lines.push(t("aiDraft.style.length", { count: h.words.median }));
  const greeting = h.greetings[0];
  // "{name}," alone is someone who opens with just the name: said in words, not as a lone mark in quotes
  // plan 162 (after ai162-r03): "Hello {name}," is "Hello" and their name, in words (the template's "Hello …," read as a placeholder)
  const opener = greeting?.text.includes("{name}") ? greeting.text.replace(/\{name\}/g, "").replace(/[\s,.!:;]+$/u, "").trim() : null;
  const set = edited && greeting !== undefined && greeting.share >= DRAFT_SHARE;
  if (greeting && (set || greeting.share >= 0.15)) {
    const nameOnly = /^\{name\}\W*$/.test(greeting.text);
    lines.push(set
      ? nameOnly ? t("aiDraft.style.greetingNameSet") : opener ? t("aiDraft.style.greetingWithNameSet", { text: opener }) : t("aiDraft.style.greetingSet", { text: shown(greeting.text) })
      : nameOnly ? t("aiDraft.style.greetingName") : opener ? t("aiDraft.style.greetingWithName", { text: opener }) : t("aiDraft.style.greeting", { text: shown(greeting.text) }));
  } else if (h.noGreeting >= 0.6) lines.push(t("aiDraft.style.noGreeting"));
  const signOff = h.signOffs[0];
  if (signOff && edited && signOff.share >= DRAFT_SHARE) lines.push(t("aiDraft.style.signOffSet", { text: shown(signOff.text) }));
  else if (signOff && signOff.share >= 0.15) lines.push(t("aiDraft.style.signOff", { text: shown(signOff.text) }));
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

/**
 * What the editor saves for a list of greetings or sign-offs: each kept item its counted share; one typed over another
 * (its place's old text gone) takes that one's share, so "Hello" changed to "Hi" is used as often as "Hello" was (plan 162,
 * after ai162-r05); a new one the share a draft's prompt starts carrying it at.
 */
export function editedShares(list: readonly { text: string; share: number }[], items: readonly string[]): { text: string; share: number }[] {
  // each with the field it was typed in, so an emptied field between doesn't shift the places
  const typed = items.map((item, at) => ({ text: fromItems([item])[0], at })).filter((x): x is { text: string; at: number } => x.text !== undefined).slice(0, ITEMS_MAX);
  const texts = typed.map((x) => x.text);
  return typed.map(({ text, at }) => {
    const kept = list.find((x) => x.text === text);
    if (kept) return { text, share: kept.share };
    const replaced = list[at];
    return { text, share: replaced && !texts.includes(replaced.text) ? replaced.share : DRAFT_SHARE };
  });
}

/** Plan 161: a list of short texts, each its own field, with remove and Add. */
function ItemsField({ label, add, item, remove, items, onChange, testId, first }: { label: string; add: string; item: (n: number) => string; remove: (n: number) => string; items: string[]; onChange: (items: string[]) => void; testId: string; first?: React.Ref<HTMLTextAreaElement> }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5" data-testid={testId}>
      <p id={id} className="text-xs font-medium text-muted-foreground">{label}</p>
      {items.map((value, i) => (
        <div key={i} className="flex items-start gap-1" data-testid={`${testId}-item`}>
          <Textarea ref={i === 0 ? first : undefined} aria-label={item(i + 1)} data-testid={`${testId}-field`} value={value} rows={1} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} className="min-h-9 resize-none py-1.5" />
          {/* plan 162: a 32 px target (it was the 20 px glyph), drawn at 24 */}
          <CloseButton size="sm" label={remove(i + 1)} className="relative mt-1.5 after:absolute after:-inset-1 after:content-['']" data-testid={`${testId}-remove`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
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

type OpenEditor = { escape: () => void; leave: (then: () => void) => void };
/**
 * Pass 3 (Codex review): the editors open on the page, for what's outside them: Esc from elsewhere on the page steps back
 * out of the last one opened first, and leaving the page (its back button) asks each changed one before a change goes.
 * Your style and a company's or person's can be open at once (Codex review, round 2), so it's a list.
 */
const openEditors: { list: OpenEditor[] } = { list: [] };

/** Esc from the page: the editor opened last steps back (cancels, or asks), if there's one. */
export function escapeStyleEditor(): boolean {
  const last = openEditors.list.at(-1);
  last?.escape();
  return last !== undefined;
}

/** Leaving the page: each open editor in turn lets it go (at once if unchanged, after asking if not), then `then`. */
export function leaveStyleEditors(then: () => void): void {
  const step = (left: readonly OpenEditor[]) => (left.length ? left[0]!.leave(() => step(left.slice(1))) : then());
  step([...openEditors.list]);
}

function ProfileEditor({ p, title, onDone }: { p: WritingProfileView; title: string; onDone: (next: WritingProfileView | null) => void }) {
  const ids = useId();
  const [greetings, setGreetings] = useState(() => p.habits.greetings.map((g) => g.text));
  const [signOffs, setSignOffs] = useState(() => p.habits.signOffs.map((g) => g.text));
  const [phrases, setPhrases] = useState(asLines(p.phrases));
  const [notes, setNotes] = useState(asLines(p.judgment?.notes ?? []));
  const first = useRef<HTMLTextAreaElement>(null);
  const phrasesRef = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  // plan 161: editing starts in its first field. Pass 2: and the editor's top is in view, so that field is on screen (the
  // Edit button was at the card's foot: the form opened above the view)
  useEffect(() => {
    (first.current ?? phrasesRef.current)?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => editor.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, []);
  // pass 3: Esc steps back out of the editor: at once when nothing changed, after asking when something did (never losing typing)
  const [asking, setAsking] = useState(false);
  // what Discard goes on to: closing the editor, or leaving the page too
  const [after, setAfter] = useState<{ next: (() => void) | null }>({ next: null });
  const changed = () =>
    JSON.stringify([fromItems(greetings), fromItems(signOffs), fromLines(phrases), fromLines(notes)]) !==
    JSON.stringify([fromItems(p.habits.greetings.map((g) => g.text)), fromItems(p.habits.signOffs.map((g) => g.text)), fromLines(asLines(p.phrases)), fromLines(asLines(p.judgment?.notes ?? []))]);
  const escape = () => {
    if (!changed()) return onDone(null);
    setAfter({ next: null });
    setAsking(true);
  };
  const leave = (then: () => void) => {
    if (!changed()) return then();
    setAfter({ next: then });
    setAsking(true);
  };
  // registered once, in the order opened, calling what this render holds
  const current = useRef({ escape, leave });
  useLayoutEffect(() => {
    current.current = { escape, leave };
  });
  useEffect(() => {
    const own: OpenEditor = { escape: () => current.current.escape(), leave: (then) => current.current.leave(then) };
    openEditors.list.push(own);
    return () => {
      openEditors.list = openEditors.list.filter((e) => e !== own);
    };
  }, []);
  const save = async () => {
    try {
      const next = await client.call("writing.profiles.edit", {
        scopeKey: p.scopeKey,
        language: p.language,
        greetings: editedShares(p.habits.greetings, greetings),
        signOffs: editedShares(p.habits.signOffs, signOffs),
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
    <div
      ref={editor}
      className="flex scroll-mt-4 flex-col gap-3"
      data-testid="style-editor"
      aria-label={t("aiDraft.style.editing", { name: title })}
      role="group"
      onKeyDown={(e) => {
        // a portal's Esc (the confirm below, a menu) bubbles here through React: only the editor's own
        if (e.key !== "Escape" || e.defaultPrevented || imeKey(e.nativeEvent) || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        escape();
      }}
    >
      <ItemsField label={t("aiDraft.style.editGreetings")} add={t("aiDraft.style.addGreeting")} item={(n) => t("aiDraft.style.greetingItem", { n })} remove={(n) => t("aiDraft.style.removeGreeting", { n })} items={greetings} onChange={setGreetings} testId="style-edit-greetings" first={first} />
      <ItemsField label={t("aiDraft.style.editSignOffs")} add={t("aiDraft.style.addSignOff")} item={(n) => t("aiDraft.style.signOffItem", { n })} remove={(n) => t("aiDraft.style.removeSignOff", { n })} items={signOffs} onChange={setSignOffs} testId="style-edit-signoffs" />
      {field("phrases", t("aiDraft.style.editPhrases"), phrases, setPhrases, "style-edit-phrases", greetings.length ? undefined : phrasesRef)}
      {p.judgment && field("notes", t("aiDraft.style.editNotes"), notes, setNotes, "style-edit-notes")}
      {/* plan 161: as Rules' footer, Save and Cancel stay in view however tall the form is. Plan 162: and what's being
          edited is said beside them, so a long form never loses its scope */}
      <div className="sticky -bottom-4 z-10 -mx-4 -mb-3 flex gap-1.5 border-t border-hairline bg-popover bg-linear-to-b from-(--card-bg) to-(--card-bg) px-4 pt-2.5 pb-6.5" data-testid="style-edit-footer">
        <Button size="sm" data-testid="style-edit-save" onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="sm" variant="ghost" data-testid="style-edit-cancel" onClick={() => onDone(null)}>{t("common.cancel")}</Button>
        <span className="ms-auto min-w-0 self-center truncate text-xs text-muted-foreground" data-testid="style-edit-scope">{t("aiDraft.style.editing", { name: title })}</span>
      </div>
      <ConfirmDialog open={asking} onOpenChange={setAsking} title={t("aiDraft.style.discardTitle")} description={t("aiDraft.style.discardHint", { name: title })} confirm={t("aiDraft.style.discard")} testId="style-discard-dialog" onConfirm={() => {
        onDone(null);
        after.next?.();
      }} />
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

const PHRASES_SHOWN = 5;

/** Pass 2: the profile with its edit, as the editor saves one: what's given replaces, the rest stays as it is. */
const editProfile = (p: WritingProfileView, change: { phrases?: string[]; notes?: string[] }) =>
  client.call("writing.profiles.edit", {
    scopeKey: p.scopeKey,
    language: p.language,
    greetings: p.habits.greetings.map((g) => ({ text: g.text, share: g.share })),
    signOffs: p.habits.signOffs.map((g) => ({ text: g.text, share: g.share })),
    phrases: change.phrases ?? [...p.phrases],
    ...(p.judgment ? { judgment: { traits: p.judgment.traits, notes: change.notes ?? [...p.judgment.notes] } } : {}),
  });

function Profile({ initial, onChanged, onEditing, onReset, total, picked, compact, reveal = 0 }: {
  initial: WritingProfileView;
  /** plan 162: Study's "Show the notes": each new value opens Phrases and notes and gives it the keys */
  reveal?: number;
  onChanged: () => void;
  /** plan 161 (Codex review): the picker waits while it's edited */
  onEditing?: (editing: boolean) => void;
  onReset: (done: ResetDone) => void;
  /** pass 2: the sent messages everything was learned from, so a profile's count reads as part of it */
  total: number | null;
  /** under the picker, which already names it: the card doesn't again */
  picked?: boolean;
  /** Companies and People: one line, opened one at a time; `locked` while a profile is being edited (switching would lose it) */
  compact?: { open: boolean; onOpenChange: (open: boolean) => void; locked: boolean };
}) {
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
  const accounts = useApp((s) => s.accounts);
  const ofAccount = accounts.length > 1 && (p.scope === "domain" || p.scope === "person") ? accounts.find((a) => a.id === Number(p.scopeKey.split(":")[1])) : undefined;
  const account = ofAccount ? ofAccount.displayName || ofAccount.email : null;
  const lines = habitLines(p.habits, p.edited);
  const examples = p.phrases.length + (p.judgment?.notes.length ?? 0);
  // plan 162 (after ai162-r01): what the count counts ("From the 64 you wrote in English"); "64 of the 181" left the rest unexplained
  const languageName = p.language ? new Intl.DisplayNames([getLocale()], { type: "language" }).of(p.language) : null;
  const from = languageName ? t("aiDraft.style.fromLanguage", { count: p.samples, language: languageName }) : total !== null && total >= p.samples ? t("aiDraft.style.fromOf", { count: p.samples, total }) : t("aiDraft.style.from", { count: p.samples });
  const [allExamples, setAllExamples] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const examplesToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reveal) return;
    setExamplesOpen(true);
    // the notes come after the phrases: all of them, so what the study added is in view
    setAllExamples(true);
    requestAnimationFrame(() => {
      examplesToggle.current?.scrollIntoView({ block: "nearest" });
      examplesToggle.current?.focus({ preventScroll: true });
    });
  }, [reveal]);
  // pass 2: a learned phrase or note that's wrong goes, as an edit does (the profile reads Edited after). Codex review: one
  // at a time, each from what the last left (two quick removals would otherwise put the first back), and the page's lists follow
  const latest = useRef(p);
  latest.current = p;
  const removals = useRef<Promise<unknown>>(Promise.resolve());
  // while one is out, Edit and switching profile wait: an editor opened on the old phrases would save the removed one back
  const [removing, setRemoving] = useState(0);
  useEffect(() => {
    if (!editing) onEditing?.(removing > 0);
  }, [removing > 0]);
  const removeExample = (kind: "phrase" | "note", text: string) => {
    setRemoving((n) => n + 1);
    removals.current = removals.current.then(async () => {
      const now = latest.current;
      const next = await editProfile(now, kind === "phrase" ? { phrases: now.phrases.filter((x) => x !== text) } : { notes: (now.judgment?.notes ?? []).filter((x) => x !== text) });
      latest.current = next;
      setP(next);
      onChanged();
    }).catch(failed).finally(() => setRemoving((n) => n - 1));
  };
  const exampleItems = [...p.phrases.map((text) => ({ kind: "phrase" as const, text })), ...(p.judgment?.notes ?? []).map((text) => ({ kind: "note" as const, text }))];
  const shownExamples = allExamples ? exampleItems : exampleItems.slice(0, PHRASES_SHOWN);
  const reset = () => {
    void client.call("writing.profiles.reset", { scopeKey: p.scopeKey, language: p.language }).then((r) => {
      onChanged();
      // plan 161: as other removals, said, with its Undo
      onReset({ name: title, undo: r.undo });
    }, failed);
  };
  const body = editing ? (
    <ProfileEditor p={p} title={title} onDone={(next) => { setEditing(false); setBack(true); if (next) setP(next); }} />
  ) : (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-0.5 text-sm" data-testid="style-profile-lines">
        {lines.map((line) => <li key={line}>{line}</li>)}
        {p.judgment && <li>{traitLine(p.judgment)}</li>}
      </ul>
      {/* plan 161: the examples second, on request; pass 2: five first, each removable */}
      {examples > 0 && (
        <Collapsible open={examplesOpen} onOpenChange={setExamplesOpen}>
          <CollapsibleTrigger ref={examplesToggle} className="-ml-1 min-h-6 w-auto gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground" data-testid="style-profile-examples-toggle">
            {t("aiDraft.style.examples", { count: examples })}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="mt-1 flex flex-col text-sm" data-testid="style-profile-examples">
              {shownExamples.map((x) => (
                <li key={`${x.kind}${x.text}`} className="group/example flex min-h-7 items-center gap-1" data-testid={x.kind === "phrase" ? "style-profile-phrase" : "style-profile-note"}>
                  <span className="min-w-0 flex-1">{x.kind === "phrase" ? `“${x.text}”` : x.text}</span>
                  {/* quiet until the row is pointed at or Tab reaches it: seventeen of them would be a column of marks */}
                  <CloseButton label={t("aiDraft.style.removePhrase", { text: x.text })} className="opacity-0 group-hover/example:opacity-100 focus-reveal:opacity-100" data-testid="style-profile-example-remove" onClick={() => removeExample(x.kind, x.text)} />
                </li>
              ))}
            </ul>
            {exampleItems.length > PHRASES_SHOWN && !allExamples && (
              <Button variant="link-secondary" size="xs" className="mt-0.5" data-testid="style-profile-examples-all" onClick={() => setAllExamples(true)}>
                {t("aiDraft.style.showAll", { count: exampleItems.length })}
              </Button>
            )}
          </CollapsiblePanel>
        </Collapsible>
      )}
      {/* plan 162: the profile's own commands are secondaries, as the page's other commands are (three idioms on one page) */}
      <div className="flex flex-wrap gap-1.5">
        <Button ref={editButton} size="sm" variant="outline" className="text-foreground" aria-label={t("aiDraft.style.editName", { name: title })} data-testid="style-profile-edit" disabled={removing > 0} onClick={() => setEditing(true)}>{t("common.edit")}</Button>
        {p.edited && p.newSince > 0 ? (
          <Button size="sm" variant="outline" className="text-foreground" data-testid="style-profile-update" onClick={reset}>{t("aiDraft.style.update", { count: p.newSince })}</Button>
        ) : (
          // plan 162 (after ai162-r04): quiet, and apart from Edit: it undoes the user's edits (it has its own Undo), so it
          // never sits at Edit's weight one misclick away (three reports)
          <Button size="sm" variant="ghost" className="ms-2 text-muted-foreground hover:text-foreground" aria-label={t("aiDraft.style.resetName", { name: title })} data-testid="style-profile-reset" onClick={reset}>{t("aiDraft.style.resetThis")}</Button>
        )}
      </div>
    </div>
  );
  const edited = p.edited && <Badge variant="secondary" data-testid="style-profile-edited">{t("aiDraft.style.edited")}</Badge>;
  if (compact)
    // pass 2: Companies and People are a list of one-line profiles; one open at a time keeps the page short
    return (
      <div ref={card} className="scroll-my-12" data-testid="style-profile" data-compact>
        <Collapsible open={compact.open} onOpenChange={compact.onOpenChange}>
          <CollapsibleTrigger disabled={compact.locked} className="-mx-2 my-1 w-[calc(100%+1rem)] gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-row-hover disabled:hover:bg-transparent" data-testid="style-profile-toggle">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium" data-testid="style-profile-title">
              <span className="truncate">{title}</span>
              {edited}
            </span>
            {/* the account too: one company can have a profile per account */}
            <span className="shrink-0 text-xs text-muted-foreground">{account ? `${account} · ` : ""}{t("aiDraft.style.from", { count: p.samples })}</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-1 pb-3">{body}</div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    );
  return (
    <div ref={card} className="scroll-my-12">
      <SettingsRow
        stacked
        label={<span className="flex items-center gap-1.5" data-testid="style-profile-title">{picked ? from : title}{edited}</span>}
        hint={picked ? undefined : from}
        testId="style-profile"
      >
        {() => body}
      </SettingsRow>
    </div>
  );
}

const profileKey = (p: Pick<WritingProfileView, "scopeKey" | "language">) => `${p.scopeKey}|${p.language}`;

/** Plan 161: your own and your accounts' profiles, one at a time, picked by whose and which language. */
function OwnProfiles({ items, onChanged, onReset, total, reveal }: { items: WritingProfileView[]; onChanged: () => void; onReset: (done: ResetDone) => void; total: number | null; reveal: number }) {
  const accounts = useApp((s) => s.accounts);
  const list = oncePerScope(items);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Codex review: Show the notes opens the profile that holds the study's notes (one merged across languages may be
  // hidden behind its languages), and only that one
  const [revealed, setRevealed] = useState<{ key: string; n: number } | null>(null);
  const picked = list.find((p) => profileKey(p) === chosen) ?? items.find((p) => profileKey(p) === chosen) ?? list[0]!;
  useEffect(() => {
    if (!reveal) return;
    const noted = items.filter((p) => (p.judgment?.notes.length ?? 0) > 0);
    const target = noted.find((p) => profileKey(p) === profileKey(picked)) ?? noted[0] ?? picked;
    setChosen(profileKey(target));
    setRevealed({ key: profileKey(target), n: reveal });
  }, [reveal]);
  const current = picked;
  const shownList = list.includes(current) ? list : [...list, current];
  const label = (p: WritingProfileView) => {
    const language = p.language ? new Intl.DisplayNames([getLocale()], { type: "language" }).of(p.language) : null;
    return language ? `${scopeTitle(p, accounts)} · ${language}` : scopeTitle(p, accounts);
  };
  const options = shownList.map((p) => ({ value: profileKey(p), label: label(p) }));
  return (
    <>
      {shownList.length > 1 && (
        <div className="flex items-center justify-between gap-6 py-2.5">
          <label id="style-scope-label" className="text-sm font-medium">{t("aiDraft.style.showing")}</label>
          <Select value={profileKey(current)} onValueChange={(v) => setChosen(v as string)} items={options} disabled={editing}>
            <SelectTrigger size="sm" className="w-64" aria-labelledby="style-scope-label" data-testid="style-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* plan 162 (after ai162-r01): grouped by whose, each language under it (ten in one flat list) */}
              {[...new Set(shownList.map((p) => scopeTitle(p, accounts)))].map((who) => (
                <SelectGroup key={who}>
                  <SelectLabel>{who}</SelectLabel>
                  {shownList.filter((p) => scopeTitle(p, accounts) === who).map((p) => (
                    <SelectItem key={profileKey(p)} value={profileKey(p)}>
                      {label(p)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Profile key={profileKey(current)} initial={current} onChanged={onChanged} onEditing={setEditing} onReset={onReset} total={total} picked={shownList.length > 1} reveal={revealed?.key === profileKey(current) ? revealed.n : 0} />
    </>
  );
}

const PAGE = 50;

/** Domains and people, read when they're opened: there can be many. */
/** Pass 2: which profile in Companies and People is open (one in both, Codex review), and which is being edited. */
type OpenProfile = { open: string | null; setOpen: (key: string | null) => void; editing: string | null; setEditing: (key: string | null) => void };

function Section({ scope, title, testId, version, onChanged, onReset, shared }: { scope: "domain" | "person"; title: string; testId: string; version: number; onChanged: () => void; onReset: (done: ResetDone) => void; shared: OpenProfile }) {
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
    <section className="mb-1 last:mb-0" data-testid={testId}>
      <Collapsible open={open} onOpenChange={(o) => !(shared.editing?.startsWith(`${scope}:`) ?? false) && setOpen(o)}>
        <CollapsibleTrigger className="-mx-2 mb-1.5 h-7 w-[calc(100%+1rem)] rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground" data-testid={`${testId}-toggle`}>
          {title}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="hairline-divide card-group px-4">
            {items === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : items.length === 0 ? <SettingsNote testId={`${testId}-empty`}>{t(scope === "domain" ? "aiDraft.style.noDomains" : "aiDraft.style.noPeople")}</SettingsNote> : oncePerScope(items).map((p) => <Profile key={profileKey(p)} initial={p} onChanged={onChanged} onReset={onReset} total={null} onEditing={(on) => shared.setEditing(on ? profileKey(p) : null)} compact={{ open: shared.open === profileKey(p), onOpenChange: (open) => shared.setOpen(open ? profileKey(p) : null), locked: shared.editing !== null }} />)}
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

type StudyState = { kind: "idle" } | { kind: "asking" } | { kind: "running"; requestId: string; done: number; total: number } | { kind: "done" } | { kind: "failed" } | { kind: "nothing" };

/** "Study my style": optional, and runs on the click (plan 131: no per-use consent; the row's hint says what goes). Pass 2: rows in "How it learns", beside the counted habits it adds to. */
function Study({ status, onChanged, onShow }: { status: WritingStatus | null; onChanged: () => void; onShow: () => void }) {
  const ai = useApp((s) => s.settings?.ai);
  const [state, setState] = useState<StudyState>({ kind: "idle" });
  // listening before asking: the study can be over before the call that started it has answered
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
      const started = await client.call("writing.studyStyle", { requestId: id });
      if (started.status === "nothing") setState({ kind: "nothing" });
      // running, with its progress and Stop, unless its events already said how it ended
      else if (asking.current === id) setState({ kind: "running", requestId: id, done: 0, total: started.total });
    } catch (e) {
      failed(e);
      setState({ kind: "idle" });
    }
  };
  return (
    <>
      <SettingsRow label={t("aiDraft.study.action")} hint={status?.study ? t("aiDraft.study.studied", { provider: ai ? providerLabel(status.study.provider as never, ai) : status.study.provider }) : t("aiDraft.study.hint")} testId="style-study-row">
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
      {/* plan 162 (after ai162-r01): done says where its result is and goes there ("What it noted is above" pointed at nothing new) */}
      {state.kind === "done" && (
        <SettingsNote testId="style-study-done">
          <span role="status" className="flex flex-wrap items-center gap-x-2">
            {t("aiDraft.study.done")}
            <Button variant="link-secondary" size="xs" className="h-6 font-medium" data-testid="style-study-show" onClick={onShow}>{t("aiDraft.study.show")}</Button>
          </span>
        </SettingsNote>
      )}
      {state.kind === "failed" && <SettingsNote testId="style-study-failed"><span role="status" className="text-destructive-ink">{t("aiDraft.study.failed")}</span></SettingsNote>}
      {state.kind === "nothing" && <SettingsNote testId="style-study-nothing">{t("aiDraft.study.nothing")}</SettingsNote>}
    </>
  );
}

export default function WritingStyle() {
  const [own, setOwn] = useState<WritingProfileView[] | null>(null);
  const [status, setStatus] = useState<WritingStatus | null>(null);
  const [version, setVersion] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [reset, setReset] = useState<ResetDone | null>(null);
  const [openProfile, setOpenProfile] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const shared: OpenProfile = { open: openProfile, setOpen: setOpenProfile, editing: editingProfile, setEditing: setEditingProfile };
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
      <div className="mb-3 px-1" data-testid="style-overview">
        <p className="text-sm" data-testid="style-status">{line}</p>
        {/* plan 162: the order as a sequence, its four steps in the ink (it read as an algorithm) */}
        <p className="mt-1 text-sm text-muted-foreground" data-testid="style-precedence">{richT("aiDraft.style.precedence", { b: (x) => <span className="text-foreground">{x}</span> })}</p>
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
      <SettingsGroup title={t("aiDraft.style.yours")} testId="style-own" className="mb-4">
        {own === null ? <SettingsNote><Spinner aria-hidden className="size-[1.15em]" /></SettingsNote> : own.length === 0 ? <SettingsNote testId="style-empty">{t("aiDraft.style.empty")}</SettingsNote> : <OwnProfiles items={own} onChanged={changed} onReset={setReset} total={status?.state === "ready" && status.messages > 0 ? status.messages : null} reveal={reveal} />}
      </SettingsGroup>
      {/* plan 162 (after ai162-r01): one job per group, in the order they're wanted: your style, the others' (they were
          under the learning and Clear all), how it learns, then starting over on its own */}
      <div className="mb-4">
        <Section scope="domain" title={t("aiDraft.style.domains")} testId="style-domains" version={version} onChanged={changed} onReset={setReset} shared={shared} />
        <Section scope="person" title={t("aiDraft.style.people")} testId="style-people" version={version} onChanged={changed} onReset={setReset} shared={shared} />
      </div>
      <SettingsGroup title={t("aiDraft.study.title")} testId="style-actions" className="mb-4">
        <SettingsRow label={t("aiDraft.style.rebuild")} hint={t("aiDraft.style.rebuildHint")} testId="style-rebuild-row">
          {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) => (
            <Button variant="outline" size="sm" aria-describedby={described} data-testid="style-rebuild" onClick={() => void client.call("writing.profiles.rebuild", {}).then(changed, failed)}>
              {t("aiDraft.style.rebuildButton")}
            </Button>
          )}
        </SettingsRow>
        <Study status={status} onChanged={changed} onShow={() => setReveal((n) => n + 1)} />
      </SettingsGroup>
      <SettingsGroup title={t("aiDraft.style.startOver")} testId="style-start-over">
        <SettingsRow label={t("aiDraft.style.clear")} hint={t("aiDraft.style.clearHint")}>
          {({ id: _id, "aria-labelledby": _l, "aria-describedby": described }) => (
            <Button variant="outline" size="sm" className="text-destructive-ink" aria-describedby={described} data-testid="style-clear" onClick={() => setClearing(true)}>
              {t("aiDraft.style.clearButton")}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title={t("aiDraft.style.clearTitle")} description={t("aiDraft.style.clearHint")} confirm={t("aiDraft.style.clearButton")} testId="style-clear-dialog" onConfirm={() => client.call("writing.profiles.clear", {}).then(() => { setReset(null); changed(); }, failed)} />
    </div>
  );
}
