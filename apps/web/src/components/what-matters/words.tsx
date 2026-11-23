import { activeRules, PREFERENCES_TEXT_MAX, type PreferenceNote, type PreferenceRule } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Spinner } from "@terno/ui/components/spinner";
import { Textarea } from "@terno/ui/components/textarea";
import { ArrowUp, Eye, EyeOff, Filter } from "@terno/ui/icons";
import { useEffect, useId, useRef, useState } from "react";
import { usd } from "~/lib/ai";
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
      <span className="font-medium">{t(`whatMatters.words.note.${note.kind}`)}</span> · {note.text}
    </li>
  );
}

/** Plan 248 §6: the look back, asked for only when the user opens it (counting reads the last 14 days' mail locally). */
function LookBack() {
  const [offer, setOffer] = useState<{ count: number; usd: number | null } | "asking" | null>(null);
  const [queued, setQueued] = useState(false);
  const ask = async () => {
    setOffer("asking");
    try {
      const r = await client.call("whatMatters.words.lookOffer", {});
      setOffer(r.offer ?? { count: 0, usd: null });
    } catch (error) {
      setOffer(null);
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  const look = async () => {
    try {
      await client.call("whatMatters.words.look", {});
      setQueued(true);
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  if (queued) return null;
  if (offer === null || offer === "asking")
    return (
      <Button variant="link-secondary" size="xs" className="self-start" data-testid="wm-words-look-ask" disabled={offer === "asking"} onClick={() => void ask()}>
        {t("whatMatters.words.look")}
      </Button>
    );
  if (!offer.count)
    return (
      <p className="text-xs text-muted-foreground" data-testid="wm-words-look-none">
        {t("whatMatters.words.lookNone")}
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="wm-words-look-offer">
      <p className="text-xs text-muted-foreground">{offer.usd !== null && offer.usd > 0 ? t("whatMatters.words.lookOffer", { count: offer.count, cost: usd(offer.usd) }) : t("whatMatters.words.lookOfferFree", { count: offer.count })}</p>
      <Button variant="outline" size="xs" data-testid="wm-words-look" onClick={() => void look()}>
        {t("whatMatters.words.look")}
      </Button>
    </div>
  );
}

/**
 * Plan 248: "In your words", where What matters' settings are. The box is the user's words, kept as typed (the draft) and
 * applied only on Save (one request to their provider, which compiles them into rules); Clear needs nothing and has Undo.
 * Under it, what Terno understood (a line per rule, what each show looks for), what it couldn't do, and the work on its
 * way. An empty box changes nothing in What matters.
 */
export function WhatMattersWords({ labelledBy, describedBy, autoFocus }: { labelledBy?: string; describedBy?: string; autoFocus?: boolean }) {
  const [state] = useWords();
  const reading = useApp((s) => s.settings?.dated?.enabled === true);
  const saved = state?.preferences.text ?? "";
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const understoodId = useId();
  const countId = useId();
  // the first read: the draft if there is one, else the saved words; afterwards what's typed stays the user's
  useEffect(() => {
    if (state && text === null) setText(state.draft?.text ?? state.preferences.text);
  }, [state, text]);
  useEffect(() => () => void (draftTimer.current && clearTimeout(draftTimer.current)), []);
  useEffect(() => {
    if (autoFocus && text !== null) field.current?.focus({ preventScroll: false });
  }, [autoFocus, text === null]);
  if (!state || text === null) return null;
  const rules = activeRules(state.preferences);
  const notes = state.preferences.text.trim() ? state.preferences.notes : [];
  const changed = text !== saved;
  const shows = rules.some((r) => r.effect === "show");
  const typed = (next: string) => {
    setText(next);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const seq = draftSeq();
    draftTimer.current = setTimeout(() => saveDraft(next, seq), DRAFT_DEBOUNCE_MS);
  };
  const save = async () => {
    if (saving || !changed) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setSaving(true);
    const r = await saveWords(text, state.preferences.revision);
    setSaving(false);
    // another window saved: show what's saved now (its words), the typed ones are in the snack's past
    if (r.stale) setText(null);
  };
  const clear = async () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (await clearWords(state.preferences.revision)) setText("");
  };
  const { status } = state;
  return (
    <div className="flex flex-col gap-2" data-testid="wm-words">
      <Textarea
        ref={field}
        aria-labelledby={labelledBy}
        aria-describedby={[describedBy, text.length >= COUNT_FROM ? countId : null].filter(Boolean).join(" ") || undefined}
        value={text}
        maxLength={PREFERENCES_TEXT_MAX}
        placeholder={t("whatMatters.words.placeholder")}
        disabled={saving}
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
              {t("whatMatters.words.blocked", { message: status.blockedBy.message })}
            </p>
          )}
          {shows && reading && !status.looking && <LookBack key={state.preferences.revision} />}
        </section>
      )}
    </div>
  );
}
