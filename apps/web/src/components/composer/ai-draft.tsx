import { parseAddressList } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronDown, Sparkles, Undo2 } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { modelName, providerLabel, writingTarget } from "~/lib/ai";
import { acknowledgeTold, answer, closeRow, commitHeld, discard, discardAndSend, includeEveryone, keepWriting, noteBody, place, placePartial, previewMode, previewText, recallInstruction, refine, retry, setInstruction, stop, submit, subscribePreview, takeFocusRequest, undoCommit, useAiDraft, type AiSession, type AiStrip } from "~/lib/ai-draft";
import { keepInView } from "~/lib/reader-scroll";
import { AI_GLYPH, aiWritten } from "../ai-card";
import { useAiDraftUi } from "~/lib/ai-draft-state";
import { useDrafts } from "~/lib/drafts";
import { setApp, useApp } from "~/state/app";
import { useController } from "./controller";


/**
 * Plan 133 §10: the row, the strip and the preview. One row in the draft's form, shaped like To and Subject and on their
 * lines; nothing floats and nothing opens a dialog. The state is in `lib/ai-draft.ts`, so all of this survives a form
 * that's destroyed under it (pinning, collapsing, another thread).
 */

/** The one row's frame: `Row`'s shape (inline-draft.tsx), its label on the first line when the content wraps. */
function Frame({ draftKey, htmlFor, children }: { draftKey: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="hairline-b group/row flex min-h-[38px] items-center gap-2.5 px-3.5" data-ai-row={draftKey} data-testid="ai-row">
      <label htmlFor={htmlFor} className="w-14 shrink-0 self-start text-xs leading-[38px] text-muted-foreground group-focus-within/row:text-foreground">
        {t("aiDraft.label")}
      </label>
      {children}
    </div>
  );
}

/** Text and controls in the row, wrapping onto more lines rather than crowding. */
const line = "flex min-h-[38px] min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 py-1.5 text-sm text-muted-foreground";
const quiet = "font-normal text-muted-foreground hover:text-foreground";

const openSettings = () => setApp({ dialog: "settings", settingsTab: "ai" });

/** A person as the strip says them: the first To's first name. */
function whoOf(toText: string): string {
  const person = parseAddressList(toText)[0];
  if (!person) return "";
  return (person.name || person.email.split("@")[0] || "").split(/\s+/)[0] ?? "";
}

function domainOf(toText: string): string {
  return parseAddressList(toText)[0]?.email.split("@")[1] ?? "";
}

/** "In your voice with Tom": only what was really used (§10.1). */
function voiceLabel(strip: AiStrip, who: string): string {
  const { used } = strip;
  if (used.learning) return t("aiDraft.voice.learning");
  if (who && (used.levels.includes("person") || used.examples > 0)) return t("aiDraft.voice.with", { name: who });
  return t("aiDraft.voice.general");
}

const LANGUAGE_REASON = {
  asked: "aiDraft.language.asked",
  thread: "aiDraft.language.thread",
  person: "aiDraft.language.person",
  inbound: "aiDraft.language.inbound",
  otherAccount: "aiDraft.language.otherAccount",
  domain: "aiDraft.language.domain",
  account: "aiDraft.language.account",
  you: "aiDraft.language.you",
  instruction: "aiDraft.language.instruction",
} as const;

/** What was used, in words, for the popover. */
function voiceLines(strip: AiStrip, who: string, domain: string): string[] {
  const { used } = strip;
  const out: string[] = [];
  const name = who || t("aiDraft.voice.them");
  if (used.language && used.languageReason !== "unknown") {
    const language = new Intl.DisplayNames([getLocale()], { type: "language" }).of(used.language) ?? used.language;
    out.push(t(LANGUAGE_REASON[used.languageReason], { language, who: name, domain: domain || name }));
  }
  if (used.history === "none" && who) out.push(used.levels.includes("domain") && domain ? t("aiDraft.voice.newDomain", { name, domain }) : t("aiDraft.voice.new", { name }));
  if (used.history === "unavailable") out.push(t("aiDraft.voice.unavailable", { name }));
  if (used.learning) out.push(t("aiDraft.voice.stillLearning"));
  if (used.levels.includes("you")) out.push(t("aiDraft.used.you"));
  if (used.levels.includes("account")) out.push(t("aiDraft.used.account"));
  if (used.levels.includes("domain") && domain) out.push(t("aiDraft.used.domain", { domain }));
  if (used.levels.includes("person")) out.push(t(used.personFromOtherAccount ? "aiDraft.used.personOther" : "aiDraft.used.person", { name }));
  if (used.examples > 0) out.push(t("aiDraft.used.examples", { count: used.examples, name }));
  if (used.threadMessages > 0) out.push(t("aiDraft.used.thread", { count: used.threadMessages }));
  if (used.pastConversations > 0) out.push(t("aiDraft.used.past", { count: used.pastConversations, name }));
  if (used.mentions > 0) out.push(t("aiDraft.used.mentions", { count: used.mentions, name }));
  if (used.inboundSnippetOnly) out.push(t("aiDraft.used.snippetOnly"));
  return out;
}

function VoicePopover({ strip, toText }: { strip: AiStrip; toText: string }) {
  const ai = useApp((s) => s.settings?.ai);
  const who = whoOf(toText);
  const lines = voiceLines(strip, who, domainOf(toText));
  return (
    <Popover>
      {/* a menu's chevron, since it opens one; it shrinks, truncated, only when the status alone can't fit (its full words are in the popover) */}
      <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className={cn(quiet, "min-w-0 shrink text-xs")} data-testid="ai-strip-voice" />}>
        <span className="truncate">{voiceLabel(strip, who)}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm" data-testid="ai-voice-popover">
        <ul className="flex flex-col gap-1">
          {lines.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t("aiDraft.language.change")}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t("aiDraft.used.model", { model: modelName(strip.used.model), provider: ai ? providerLabel(strip.used.provider, ai) : strip.used.provider })}</p>
        <Button
          type="button"
          variant="link-secondary"
          className="mt-2 self-start text-xs"
          data-testid="ai-voice-style"
          onClick={() => {
            useAiDraftUi.setState({ stylePage: true });
            openSettings();
          }}
        >
          {t("aiDraft.style.title")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function Strip({ s }: { s: AiSession & { strip: AiStrip } }) {
  const toText = useDrafts((state) => state.drafts[s.key]?.toText ?? "");
  const { strip } = s;
  return (
    <div className={cn(line, "py-[5px]")} data-testid="ai-strip" data-edited={strip.edited || undefined}>
      {/* plan 161: a status, not a control (the secondary type, no shape), and never dropped: the commands wrap below it instead */}
      <span className="flex min-w-0 flex-1 items-center gap-x-1">
        <span className="flex shrink-0 items-center gap-1.5 text-xs" data-testid="ai-strip-written">
          <Sparkles aria-hidden className={AI_GLYPH} />
          {aiWritten(strip.edited === true)}
        </span>
        <VoicePopover strip={strip} toText={toText} />
      </span>
      {/* the commands: BoardUI's secondary buttons, ending on the line Cc, Bcc and Subject end on; Undo set apart, with its glyph */}
      <span className="ml-auto flex shrink-0 items-center gap-1.5" data-testid="ai-strip-commands">
        <Button type="button" variant="outline" size="sm" data-testid="ai-strip-regenerate" onClick={() => refine(s.key, "regenerate")}>
          {t("aiDraft.regenerate")}
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="ai-strip-shorter" onClick={() => refine(s.key, "shorter")}>
          {t("aiDraft.shorter")}
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="ai-strip-warmer" onClick={() => refine(s.key, "warmer")}>
          {t("aiDraft.warmer")}
        </Button>
        <Button type="button" variant="outline" size="sm" className="ml-1.5" data-testid="ai-strip-undo" onClick={() => undoCommit(s.key)}>
          <Undo2 aria-hidden />
          {t("common.undo")}
        </Button>
      </span>
      {/* the same notes the Status had, in the same place: the row keeps its height across the commit */}
      {s.confirmFailed && <p className="w-full text-xs">{t("aiDraft.confirmFailed")}</p>}
      {s.everyone > 0 && (
        <Button type="button" variant="link-secondary" className="w-fit text-xs" data-testid="ai-include-everyone" onClick={() => void includeEveryone(s.key)}>
          {t("aiDraft.includeEveryone", { count: s.everyone })}
        </Button>
      )}
    </div>
  );
}

function stripChecks(strip: AiStrip): string[] {
  const specifics = strip.checks.specifics.map((f) => f.text);
  return [
    ...(specifics.length ? [t("aiDraft.check.specifics", { items: specifics.slice(0, 3).join(", "), count: specifics.length })] : []),
    ...(strip.cutOff ? [t("aiDraft.check.cutOff")] : []),
    ...(strip.oneTap ? [t("aiDraft.check.oneTap")] : []),
  ];
}

function Status({ s }: { s: AiSession }) {
  const local = useApp((state) => writingTarget(state.settings?.ai).local);
  const run = s.run;
  const text = run?.slow ? (local && !run.streaming ? t("aiDraft.loadingModel") : t("aiDraft.stillWriting")) : t("aiDraft.writing");
  return (
    <div className={line} data-testid="ai-row-status" data-state={s.phase}>
      <Spinner aria-hidden className="size-[1.15em] text-muted-foreground" />
      <span data-testid="ai-row-status-text">{s.phase === "waitingBody" ? t("aiDraft.downloading") : text}</span>
      <Button type="button" variant="ghost" size="xs" className={cn(quiet, "-mr-0.5 ml-auto")} data-testid="ai-row-stop" onClick={() => stop(s.key)}>
        {t("aiDraft.stop")}
      </Button>
      {s.confirmFailed && <p className="w-full text-xs">{t("aiDraft.confirmFailed")}</p>}
      {s.everyone > 0 && (
        <Button type="button" variant="link-secondary" className="w-fit text-xs" data-testid="ai-include-everyone" onClick={() => void includeEveryone(s.key)}>
          {t("aiDraft.includeEveryone", { count: s.everyone })}
        </Button>
      )}
    </div>
  );
}

function Question({ s }: { s: AiSession }) {
  const q = s.question;
  if (!q || q.type === "who") return null;
  const name = q.to.name.split(/\s+/)[0] || q.to.address;
  const choice = (id: "forward" | "new" | "reply" | "add" | "justWrite", label: string, primary = false) => (
    <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default={primary || undefined} data-testid={`ai-choice-${id}`} onClick={() => void answer(s.key, id)}>
      {label}
      {primary && <Shortcut keys="enter" className="ml-0.5" />}
    </Button>
  );
  return (
    <div className={line} data-testid="ai-question" data-question={q.type}>
      {q.type === "forward-or-new" && (
        <>
          <span>{t("aiDraft.question.notHere", { name })}</span>
          {choice("forward", t("aiDraft.question.forward", { name }), true)}
          {choice("new", t("aiDraft.question.newTo", { name }))}
        </>
      )}
      {q.type === "new-or-reply" && (
        <>
          {choice("new", t("aiDraft.question.new"), true)}
          {choice("reply", t("aiDraft.question.replyOn", { subject: q.thread.subject }))}
        </>
      )}
      {q.type === "add-or-just-write" && (
        <>
          <span>{t("aiDraft.question.notOnDraft", { name })}</span>
          {choice("add", t("aiDraft.question.add", { name }), true)}
          {choice("justWrite", t("aiDraft.question.justWrite"))}
        </>
      )}
    </div>
  );
}

function Telling({ s }: { s: AiSession }) {
  const ai = useApp((state) => state.settings?.ai);
  const provider = ai ? providerLabel(writingTarget(ai).provider, ai) : "";
  return (
    <div className={line} data-testid="ai-telling">
      <p className="w-full text-xs leading-relaxed">{t("aiDraft.telling", { provider })}</p>
      <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-telling-continue" onClick={() => acknowledgeTold(s.key)}>
        {t("common.continue")}
        <Shortcut keys="enter" className="ml-0.5" />
      </Button>
      <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-telling-settings" onClick={openSettings}>
        {t("common.settings")}
      </Button>
    </div>
  );
}

function NoProvider({ s }: { s: AiSession }) {
  return (
    <div className={line} data-testid="ai-no-provider" role="status">
      <span>{t("aiDraft.noProvider")}</span>
      <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-no-provider-settings" onClick={() => { closeRow(s.key); openSettings(); }}>
        {t("aiDraft.openAiSettings")}
      </Button>
      <CloseButton className="ml-auto" label={t("common.close")} onClick={() => closeRow(s.key)} data-testid="ai-row-close" />
    </div>
  );
}

function ErrorLine({ s }: { s: AiSession }) {
  const e = s.error;
  if (!e) return null;
  return (
    <div className={line} data-testid="ai-error" data-kind={e.kind}>
      <p role="alert" className="min-w-0 basis-full text-sm" data-testid="ai-error-text">
        <span className="text-foreground">{e.message}</span>
        {e.help ? ` ${e.help}` : ""}
      </p>
      {e.partial && (
        <Button type="button" variant="outline" size="xs" className="font-normal" data-testid="ai-error-insert" onClick={() => placePartial(s.key)}>
          {t("aiDraft.insert")}
        </Button>
      )}
      {e.retry && (
        <Button type="button" variant="ghost" size="xs" className={quiet} data-ai-default data-testid="ai-error-retry" onClick={() => retry(s.key)}>
          {t("aiDraft.tryAgain")}
        </Button>
      )}
      <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-error-close" onClick={() => (e.partial ? discard(s.key) : closeRow(s.key))}>
        {e.partial ? t("aiDraft.discard") : t("common.close")}
      </Button>
    </div>
  );
}

function Choice({ s }: { s: AiSession }) {
  const c = s.choice;
  if (!c) return null;
  const notes = c.reason === "notes";
  return (
    <div className={line} data-testid="ai-choice" data-reason={c.reason}>
      <span data-testid="ai-choice-text">{t(notes ? "aiDraft.choice.notes" : "aiDraft.choice.ready")}</span>
      {c.writtenFor && <span data-testid="ai-written-for">{t("aiDraft.choice.writtenFor", { name: c.writtenFor })}</span>}
      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-1">
        {notes ? (
          <>
            <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-choice-replace" onClick={() => place(s.key, "replace")}>
              {t("aiDraft.replace")}
            </Button>
            <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-choice-below" onClick={() => place(s.key, "below")}>
              {t("aiDraft.insertBelow")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-choice-insert" onClick={() => place(s.key, "below")}>
            {t("aiDraft.insert")}
          </Button>
        )}
        <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-choice-discard" onClick={() => discard(s.key)}>
          {t("aiDraft.discard")}
        </Button>
      </span>
    </div>
  );
}

/** Plan 161: Send stopped by a gap the model left: which, and the two answers, inline as the guard is. */
function GapsGuard({ s, gaps }: { s: AiSession; gaps: string[] }) {
  return (
    <div className={line} data-testid="ai-gaps" role="alert">
      <span className="min-w-0 text-foreground" data-testid="ai-gaps-text">{t("aiDraft.gaps.text", { count: gaps.length, gaps: gaps.join(" ") })}</span>
      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" data-ai-default data-testid="ai-gaps-fill" onClick={() => keepWriting(s.key)}>
          {t("aiDraft.gaps.fill")}
        </Button>
        <Button type="button" variant="ghost" size="sm" className={quiet} data-testid="ai-gaps-send" onClick={() => discardAndSend(s.key)}>
          {t("aiDraft.gaps.send")}
        </Button>
      </span>
    </div>
  );
}

function Guard({ s }: { s: AiSession }) {
  if (s.guard?.gaps?.length) return <GapsGuard s={s} gaps={s.guard.gaps} />;
  const writing = s.phase === "writing" || s.phase === "waitingBody";
  return (
    <div className={line} data-testid="ai-guard" role="alert">
      <span className="text-foreground">{t(writing ? "aiDraft.guard.writing" : "aiDraft.guard.ready")}</span>
      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-1">
        <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-guard-send" onClick={() => discardAndSend(s.key)}>
          {t(writing ? "aiDraft.guard.stopSend" : "aiDraft.guard.discardSend")}
        </Button>
        <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-guard-keep" onClick={() => keepWriting(s.key)}>
          {t("aiDraft.guard.keep")}
        </Button>
      </span>
    </div>
  );
}

function Field({ s, id }: { s: AiSession; id: string }) {
  // the editor's, as it is now: the draft's copy lags it until the next save
  const notes = useController(s.key)?.empty() === false;
  const threaded = useDrafts((state) => (state.drafts[s.key]?.mode ?? "new") !== "new");
  const working = s.phase === "resolving";
  const placeholder = s.strip ? t("aiDraft.placeholder.refine") : notes ? t("aiDraft.placeholder.notes") : threaded ? t("aiDraft.placeholder.reply") : t("aiDraft.placeholder.new");
  return (
    <>
      {/* one line that grows to show all it holds (plan 161: a long instruction was cut mid-word); Return still writes */}
      <textarea
        id={id}
        data-testid="ai-row-input"
        rows={1}
        className="field-sizing-content min-h-9 min-w-0 flex-1 resize-none bg-transparent py-[9px] text-sm leading-5 outline-none placeholder:text-muted-foreground"
        value={s.instruction}
        readOnly={working}
        autoComplete="off"
        spellCheck
        placeholder={placeholder}
        onChange={(e) => setInstruction(s.key, e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            // Enter drafts; ⌘Enter here means the same, never the form's Send
            e.preventDefault();
            e.stopPropagation();
            if (!working) void submit(s.key);
          } else if (e.key === "ArrowUp" && e.currentTarget.selectionStart === 0 && !s.instruction) {
            if (recallInstruction(s.key)) e.preventDefault();
          }
        }}
      />
      {working ? <Spinner aria-hidden className="size-[1.15em] shrink-0 text-muted-foreground" /> : s.who ? (
        <Button type="button" variant="outline" size="sm" className="mt-[5px] shrink-0 self-start" data-testid="ai-who-write" onClick={() => void submit(s.key)}>
          {t("aiDraft.whoWrite")}
        </Button>
      ) : (
        // a named button, not a bare ↵: what Return does, said
        <Button type="button" variant="outline" size="sm" className="mt-[5px] shrink-0 self-start" data-testid="ai-row-write" onMouseDown={(e) => e.preventDefault()} onClick={() => void submit(s.key)}>
          {t("aiDraft.submit")}
          <Shortcut keys="enter" className="ml-0.5" />
        </Button>
      )}
    </>
  );
}

/** The row, whichever state it's in. */
export function AiRow({ draftKey }: { draftKey: string }) {
  const s = useAiDraft((state) => state.sessions[draftKey]);
  const c = useController(draftKey);
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // the text's changes, once there's an editor to listen to
  useEffect(() => c?.subscribeDoc(() => noteBody(draftKey)), [c, draftKey]);
  // what finished while the form was gone goes in now
  const phase = s?.phase;
  useEffect(() => {
    if (phase === "held" && c) commitHeld(draftKey);
  }, [phase, c, draftKey]);
  // plan 161: a write that went in brings the whole composer into view, so the draft and Send are on screen (a small window
  // left its end under the foot); not on coming back to a strip written earlier
  const writes = s?.strip?.stack.length ?? 0;
  const seenWrites = useRef(writes);
  useEffect(() => {
    const was = seenWrites.current;
    seenWrites.current = writes;
    if (writes <= was) return;
    const form = rootRef.current?.closest<HTMLElement>("form[data-draft-key]");
    if (form) return keepInView(form, undefined, 16, () => form.getBoundingClientRect().height);
  }, [writes]);
  // asked for: the field, or the row's default choice. Programmatic, so no ring (plan 54)
  const focus = s?.focus ?? 0;
  useLayoutEffect(() => {
    if (!takeFocusRequest(draftKey, focus)) return;
    rootRef.current?.querySelector<HTMLElement>("[data-ai-default], [data-testid=ai-row-input]")?.focus({ preventScroll: true });
  }, [draftKey, focus]);
  if (!s) return null;
  const content = (() => {
    if (s.guard) return <Guard s={s} />;
    switch (s.phase) {
      case "input":
      case "resolving":
        return (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5">
            <Field s={s} id={inputId} />
            {s.who && <p className="mb-1.5 w-full text-xs text-muted-foreground" data-testid="ai-who">{t("aiDraft.who")}</p>}
            {s.lookingUp && <p className="mb-1.5 w-full text-xs text-muted-foreground" data-testid="ai-looking-up">{t("aiDraft.lookingUp")}</p>}
          </div>
        );
      case "question":
        return <Question s={s} />;
      case "telling":
        return <Telling s={s} />;
      case "writing":
      case "waitingBody":
        return <Status s={s} />;
      case "choice":
        return <Choice s={s} />;
      case "strip":
        return s.strip ? <Strip s={s as AiSession & { strip: AiStrip }} /> : null;
      case "error":
        return <ErrorLine s={s} />;
      case "noProvider":
        return <NoProvider s={s} />;
      case "held":
        return null;
    }
  })();
  return (
    <div ref={rootRef}>
      <Frame draftKey={draftKey} htmlFor={s.phase === "input" || s.phase === "resolving" ? inputId : undefined}>
        {content}
      </Frame>
      {/* never the deltas: "Writing draft", then "Draft ready, 84 words" */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="ai-live">
        {s.live}
      </span>
    </div>
  );
}

/** A line per paragraph, as the editor makes them; only what changed is touched (at 30 ms a delta, on long text). */
export function writePreview(el: HTMLElement, text: string): void {
  const lines = text.trim() === "" ? [] : text.replace(/\r\n?/g, "\n").trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    let p = el.children[i] as HTMLElement | undefined;
    if (!p) p = el.appendChild(document.createElement("p"));
    const value = lines[i]!;
    if (p.dataset.line === value && p.isConnected) continue;
    p.dataset.line = value;
    if (value) p.textContent = value;
    else p.replaceChildren(document.createElement("br"));
  }
  while (el.children.length > lines.length) el.lastElementChild!.remove();
}

/**
 * The stream, in normal flow where the body will be, in the composer's type: not in the document, its history or
 * autosave. Hidden from screen readers while it's writing; a suggestion waiting for a choice can be read.
 */
export function AiPreview({ draftKey, className }: { draftKey: string; className?: string }) {
  const s = useAiDraft((state) => state.sessions[draftKey]);
  const mode = previewMode(s);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    writePreview(el, previewText(draftKey));
    return subscribePreview(draftKey, () => {
      // it follows the last line while that's in view, and never pulls back someone who has scrolled up to read
      const scroller = el.closest("[data-draft-scroll]");
      const limit = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      const last = el.lastElementChild;
      const inView = !last || last.getBoundingClientRect().bottom <= limit + 1;
      writePreview(el, previewText(draftKey));
      if (inView) el.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
  }, [draftKey, mode]);
  // the editor's cell shows it: without its placeholder or caret, with its old text gone when refining, tight above it below
  useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || !mode) return;
    host.setAttribute("data-ai-overlay", mode);
    return () => host.removeAttribute("data-ai-overlay");
  }, [mode]);
  // under the text, not in the row: a line added above the body at commit would move every word it just wrote
  const checks = s?.phase === "strip" && s.strip ? stripChecks(s.strip) : [];
  if (!mode) {
    if (!checks.length) return null;
    return (
      <p className="px-3.5 pb-1 text-xs text-muted-foreground [grid-area:2/1]" data-testid="ai-strip-check">
        {checks.join(" ")}
      </p>
    );
  }
  const below = mode === "below";
  // never while it's writing: only text waiting for a choice (a suggestion, what came before a failure) can be read
  const waiting = s?.phase === "choice" || s?.phase === "error";
  return (
    <div
      ref={rootRef}
      data-testid="ai-preview"
      data-mode={mode}
      aria-hidden={waiting ? undefined : true}
      role={waiting ? "region" : undefined}
      aria-label={waiting ? t("aiDraft.suggestion") : undefined}
      className={cn(below ? "hairline-t mx-3.5 mt-2 pt-2 pb-1 [grid-area:2/1]" : "pointer-events-none [grid-area:1/1]")}
    >
      {below && <p className="mb-1 text-xs text-muted-foreground">{t("aiDraft.suggestion")}</p>}
      <div ref={textRef} data-testid="ai-preview-text" className={cn("rt-body rt-ai-preview type-body", below ? "rt-measure" : className)} />
    </div>
  );
}
