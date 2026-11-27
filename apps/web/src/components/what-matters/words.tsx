import { activeRules, PREFERENCES_TEXT_MAX, type PreferenceNote, type PreferenceRule } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Spinner } from "@terno/ui/components/spinner";
import { Textarea } from "@terno/ui/components/textarea";
import { ArrowUp, Eye, EyeOff, Filter } from "@terno/ui/icons";
import { useEffect, useId, useRef, useState } from "react";
import { usd } from "~/lib/ai";
import { localized } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { clearWords, draftSeq, saveDraft, saveWords, useWords } from "~/lib/what-matters-words";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

/** a draft is kept this long after the last keystroke */
const DRAFT_DEBOUNCE_MS = 600;
/** the count shows from here on, before the limit stops more */
const COUNT_FROM = PREFERENCES_TEXT_MAX - 200;

const EFFECT_ICON = { show: Eye, hide: EyeOff, first: ArrowUp, only: Filter } as const;

/** One rule said back: its effect as a quiet icon (named for screen readers), its words, and what a show looks for. */
function RuleLine({ rule }: { rule: PreferenceRule }) {
  const Icon = EFFECT_ICON[rule.effect];
  return (
    <li className="flex items-start gap-2 py-1 text-sm" data-testid="wm-words-rule" data-effect={rule.effect}>
      <Icon aria-hidden className="mt-[0.2em] size-[1.15em] shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{t(`whatMatters.words.${rule.effect}`)}: </span>
        {rule.understood}
        {rule.effect === "show" && !!rule.cues?.length && <span className="block text-xs text-muted-foreground">{t("whatMatters.words.watching", { cues: rule.cues.slice(0, 8).join(", ") })}</span>}
      </span>
    </li>
  );
}

function NoteLine({ note }: { note: PreferenceNote }) {
  return (
    <li className="py-0.5 text-xs text-muted-foreground" data-testid="wm-words-note" data-kind={note.kind}>
      <span className="font-medium">{t(`whatMatters.words.note.${note.kind}`)}</span> · {localized(note.text, note.i18n)}
    </li>
  );
}

/**
 * Plan 249 §6: the look back, asked for only when the user opens it (counting reads the last 14 days' mail locally). One
 * status line holds the focus's place as it moves on (the Fable review): the count, the yes, then what's queued.
 */
function LookBack() {
  const [offer, setOffer] = useState<{ count: number; usd: number | null; revision: number; looked: boolean } | "asking" | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "queued">("idle");
  const yes = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const ask = async () => {
    setOffer("asking");
    try {
      const r = await client.call("whatMatters.words.lookOffer", {});
      setOffer(r.offer ?? { count: 0, usd: null, revision: -1, looked: false });
      requestAnimationFrame(() => (yes.current ?? said.current)?.focus({ preventScroll: true }));
    } catch (error) {
      setOffer(null);
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  const look = async (revision: number) => {
    // once: a second click while the first is on its way buys nothing twice (the Astra review)
    if (state !== "idle") return;
    setState("sending");
    try {
      // the words changed since this was counted (another window): counted again, for them
      if ("stale" in (await client.call("whatMatters.words.look", { revision }))) {
        setState("idle");
        return void ask();
      }
      setState("queued");
      requestAnimationFrame(() => said.current?.focus({ preventScroll: true }));
    } catch (error) {
      setState("idle");
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  if (offer === null || offer === "asking")
    return (
      <Button variant="link-secondary" size="xs" className="self-start" data-testid="wm-words-look-ask" disabled={offer === "asking"} onClick={() => void ask()}>
        {t("whatMatters.words.look")}
      </Button>
    );
  const line = state === "queued" ? t("whatMatters.words.lookQueued") : offer.looked ? t("whatMatters.words.looked") : !offer.count ? t("whatMatters.words.lookNone") : offer.usd !== null && offer.usd > 0 ? t("whatMatters.words.lookOffer", { count: offer.count, cost: usd(offer.usd) }) : t("whatMatters.words.lookOfferFree", { count: offer.count });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="wm-words-look-offer">
      <p ref={said} tabIndex={-1} role="status" className="text-xs text-muted-foreground outline-none" data-testid={offer.count || state === "queued" ? "wm-words-look-line" : "wm-words-look-none"}>
        {line}
      </p>
      {!!offer.count && state !== "queued" && (
        <Button ref={yes} variant="outline" size="xs" data-testid="wm-words-look" disabled={state === "sending"} onClick={() => void look(offer.revision)}>
          {t("whatMatters.words.look")}
        </Button>
      )}
    </div>
  );
}

/**
 * Plan 249: "In your words", where What matters' settings are. The box is the user's words, kept as typed (the draft) and
 * applied only on Save (one request to their provider, which compiles them into rules); Clear needs nothing and has Undo.
 * Under it, what Terno understood (a line per rule, what each show looks for), what it couldn't do, and the work on its
 * way. An empty box changes nothing in What matters.
 */
export function WhatMattersWords({ id, labelledBy, describedBy }: { /** the box's, for its row's <label for> */ id?: string; labelledBy?: string; describedBy?: string }) {
  const [state] = useWords();
  const reading = useApp((s) => s.settings?.dated?.enabled === true);
  const [text, setText] = useState<string | null>(null);
  // the saved words the box was typed on, and their revision: Save is against it, so another window's save since is
  // refused rather than overwritten (the Codex code review), and an untouched box follows a change made elsewhere
  const [base, setBase] = useState<{ revision: number; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ text: string; seq: number } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const understoodId = useId();
  const countId = useId();
  const saved = base?.text ?? "";
  // the first read: the draft if there is one, else the saved words; afterwards what's typed stays the user's, and a box
  // with nothing typed in it follows the saved words when they change (another window, Clear's Undo)
  useEffect(() => {
    if (!state) return;
    const now = { revision: state.preferences.revision, text: state.preferences.text };
    if (text === null) {
      setText(state.draft?.text ?? now.text);
      setBase(now);
    } else if (base && now.revision !== base.revision && text === base.text) {
      setText(now.text);
      setBase(now);
    }
  }, [state, text, base]);
  // a draft still on its way is kept when Settings closes (never lost to the debounce)
  const flush = () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (pending.current) saveDraft(pending.current.text, pending.current.seq);
    pending.current = null;
  };
  useEffect(() => () => flush(), []);
  if (!state || text === null || !base) return null;
  const rules = activeRules(state.preferences);
  const notes = state.preferences.text.trim() ? state.preferences.notes : [];
  const changed = text !== saved;
  const shows = rules.some((r) => r.effect === "show");
  const typed = (next: string) => {
    setText(next);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    pending.current = { text: next, seq: draftSeq() };
    draftTimer.current = setTimeout(flush, DRAFT_DEBOUNCE_MS);
  };
  const save = async () => {
    if (saving || !changed) return;
    // emptied and saved is Clear, with its Undo (the Fable review)
    if (!text.trim()) return void clear();
    // the draft first: a failed compile keeps what was typed, across closing Settings too
    flush();
    setSaving(true);
    const r = await saveWords(text, base.revision);
    setSaving(false);
    // another window saved: these words stay in the box (and the draft), now against what's saved there, so a second Save
    // is the user's choice and nothing typed is lost (the Codex re-review)
    if (r.stale) {
      setBase({ revision: r.stale.revision, text: r.stale.text });
      typed(text);
    } else if (r.saved) setBase({ revision: base.revision + 1, text });
  };
  const clear = async () => {
    flush();
    if (await clearWords(base.revision)) {
      setText("");
      setBase({ revision: base.revision + 1, text: "" });
      // Clear goes with the words: the focus to the box (the Fable review)
      field.current?.focus({ preventScroll: true });
    }
  };
  const { status } = state;
  return (
    <div className="flex flex-col gap-2" data-testid="wm-words">
      <Textarea
        ref={field}
        id={id}
        aria-labelledby={labelledBy}
        aria-describedby={[describedBy, text.length >= COUNT_FROM ? countId : null].filter(Boolean).join(" ") || undefined}
        value={text}
        maxLength={PREFERENCES_TEXT_MAX}
        placeholder={t("whatMatters.words.placeholder")}
        readOnly={saving}
        aria-busy={saving}
        rows={3}
        className="max-h-64"
        data-testid="wm-words-field"
        onChange={(e) => typed(e.currentTarget.value)}
        onKeyDown={(e) => {
          // ⌘↩ (Ctrl+Enter elsewhere) saves, as a composer sends
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex min-h-7 items-center gap-3">
        <Button size="sm" disabled={!changed || saving} data-testid="wm-words-save" onClick={() => void save()}>
          {saving ? t("whatMatters.words.saving") : t("whatMatters.words.save")}
        </Button>
        {saving && <Spinner aria-hidden />}
        {!!saved.trim() && !saving && (
          <Button variant="link-secondary" size="xs" data-testid="wm-words-clear" onClick={() => void clear()}>
            {t("whatMatters.words.clear")}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {changed && !saving && <span data-testid="wm-words-unsaved">{t("whatMatters.words.notSaved")}</span>}
          {text.length >= COUNT_FROM && (
            <span id={countId} data-testid="wm-words-count">
              {t("whatMatters.words.count", { count: text.length, max: PREFERENCES_TEXT_MAX })}
            </span>
          )}
        </span>
      </div>
      {(rules.length > 0 || notes.length > 0) && (
        <section aria-labelledby={understoodId} className="flex flex-col gap-1 border-t border-hairline pt-2" data-testid="wm-words-understood">
          <p id={understoodId} className="text-xs font-medium text-muted-foreground">
            {t("whatMatters.words.understood")}
          </p>
          {rules.length > 0 && <ul className="flex flex-col">{rules.map((r) => <RuleLine key={r.key} rule={r} />)}</ul>}
          {notes.length > 0 && <ul className="flex flex-col">{notes.map((n, i) => <NoteLine key={`${n.kind}-${i}`} note={n} />)}</ul>}
          {shows && !reading && (
            <p className="text-xs text-muted-foreground" data-testid="wm-words-no-reader">
              {t("whatMatters.words.noReader")}
            </p>
          )}
          {status.applying && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="wm-words-applying">
              {t("whatMatters.words.applying", { left: status.applying.left })}
            </p>
          )}
          {status.looking && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="wm-words-looking">
              {t("whatMatters.words.looking", { left: status.looking.left })}
            </p>
          )}
          {status.blockedBy && (
            <p className="text-xs text-muted-foreground" data-testid="wm-words-blocked">
              {t("whatMatters.words.blocked", { message: localized(status.blockedBy.message, status.blockedBy.i18n) })}
            </p>
          )}
          {shows && reading && !status.looking && <LookBack key={state.preferences.revision} />}
        </section>
      )}
    </div>
  );
}
