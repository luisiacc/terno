import { parseAddressList } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { ButtonGroup, ButtonGroupItem } from "@terno/ui/components/button-group";
import { CloseButton } from "@terno/ui/components/close-button";
import { Shortcut, shortcutText } from "@terno/ui/components/shortcut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronDown, PenLine, TriangleAlert, Undo2 } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { modelName, providerLabel, writingTarget } from "~/lib/ai";
import { answer, closeRow, commitHeld, offersReplace, confirmReplace, discard, discardAndSend, includeEveryone, keepEdits, keepWriting, noteBody, place, placePartial, previewMode, previewText, primed, refine, retry, rewriteFrom, stop, submit, subscribePreview, takeFocusRequest, undoCommit, useAiDraft, type AiSession, type AiStrip } from "~/lib/ai-draft";
import { keepInView } from "~/lib/reader-scroll";
import { AiErrorNotice, AiProvenance, aiErrorCopy, aiWritten, errorTarget } from "../ai-card";
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

/**
 * Plan 163: what was asked, in the user's words, in the popover (the owner: no instruction row, no big labelled button):
 * a quiet line with an icon-only pencil, which turns it into a field; Return writes the draft again from the new words.
 */
function Asked({ s, text }: { s: AiSession; text: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (editing) field.current?.focus({ preventScroll: true });
  }, [editing]);
  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <textarea
          ref={field}
          data-testid="ai-asked-input"
          aria-label={t("aiDraft.asked.field")}
          rows={2}
          className="field-sizing-content min-h-9 w-full resize-none rounded-md bg-field px-2 py-1.5 text-sm leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value}
          spellCheck
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
              rewriteFrom(s.key, value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setValue(text);
              setEditing(false);
            }
          }}
        />
        <p className="text-xs text-muted-foreground">{t("aiDraft.asked.hint")}</p>
      </div>
    );
  }
  return (
    <p className="flex min-w-0 items-start gap-1" data-testid="ai-asked">
      <span className="min-w-0 wrap-anywhere" data-testid="ai-asked-text">{t("aiDraft.asked", { instruction: text })}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" variant="ghost" size="icon-xs" className="-my-0.5 shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("aiDraft.asked.edit")} data-testid="ai-asked-edit" onClick={() => { setValue(text); setEditing(true); }} />
          }
        >
          <PenLine aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{t("aiDraft.asked.edit")}</TooltipContent>
      </Tooltip>
    </p>
  );
}

/** Plan 163: each gap and what went in it, or that it's as they wrote it. */
function Fills({ fill }: { fill: NonNullable<AiStrip["fill"]> }) {
  return (
    <div data-testid="ai-fills">
      <p className="mb-1 font-medium">{t("aiDraft.fill.title")}</p>
      <ul className="flex flex-col gap-1">
        {fill.words.map((gap, i) => {
          const value = fill.fills[i];
          return (
            <li key={`${i}-${gap}`} className="wrap-anywhere" data-testid="ai-fill-pair">
              {value ? t("aiDraft.fill.pair", { gap, fill: value }) : t("aiDraft.fill.left", { gap })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Plan 161, pass 2: the strip's status is the one way into what the AI used. Pass 3: it is the one provenance control every AI
 * surface has (`AiProvenance`), at the command line's end: "Written with AI ▾" opens the voice ("In your voice with Arjun"),
 * what it read, and the model. Plan 163: and what was asked, with its pencil; for a fill, what went in each gap.
 */
function StatusPopover({ s, strip, toText }: { s: AiSession; strip: AiStrip; toText: string }) {
  const ai = useApp((state) => state.settings?.ai);
  const who = whoOf(toText);
  // a stopped write's use was never reported: it says that, not a voice it may not have used
  const lines = strip.stopped ? [] : voiceLines(strip, who, domainOf(toText));
  return (
    <AiProvenance
      model={strip.used.model}
      at={0}
      label={aiWritten(strip.edited === true, strip.stopped === true)}
      detail={t("aiDraft.used.model", { model: modelName(strip.used.model), provider: ai ? providerLabel(strip.used.provider, ai) : strip.used.provider })}
      testId="ai-strip-voice"
      labelTestId="ai-strip-written"
      popoverTestId="ai-voice-popover"
      className="-me-1.5 ms-auto"
    >
      {strip.instruction && !strip.fill && <Asked s={s} text={strip.instruction} />}
      {strip.fill && <Fills fill={strip.fill} />}
      {strip.stopped ? (
        <p data-testid="ai-voice-label">{t("aiDraft.stoppedDetail")}</p>
      ) : (
        <div>
          <p className="mb-1 font-medium" data-testid="ai-voice-label">{voiceLabel(strip, who)}</p>
          <ul className="flex flex-col gap-1">
            {lines.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {strip.oneTap && <p className="text-xs text-muted-foreground" data-testid="ai-voice-content">{t("aiDraft.content.alone")}</p>}
      {/* a fill matches its sentence's language: asking for another is a draft's, not a fill's */}
      {!strip.fill && <p className="text-xs text-muted-foreground">{t("aiDraft.language.change")}</p>}
      <Button
        type="button"
        variant="link-secondary"
        className="self-start text-xs"
        data-testid="ai-voice-style"
        onClick={() => {
          useAiDraftUi.setState({ stylePage: true });
          openSettings();
        }}
      >
        {t("aiDraft.style.title")}
      </Button>
    </AiProvenance>
  );
}

/**
 * The strip's Undo: the AI's last write taken back, first in the strip's group. Plan 162: one chrome for the four commands
 * (BoardUI's button group, as the reader's Reply and Forward), so none outranks another and none is bare text. `alone` is
 * the row's field over a strip, where it's the only command: the group's look on one item.
 */
function UndoButton({ s, alone }: { s: AiSession; alone?: boolean }) {
  // plan 162 (after ai162-r02): what it takes back, in its name and tooltip ("Undo Shorter"; the first draft: "Remove the AI's draft")
  const top = s.strip?.stack.at(-1);
  const what = top?.how === "fill" ? t("aiDraft.undo.fill") : !top || (s.strip?.stack.length ?? 0) <= 1 ? t("aiDraft.undo.draft") : t(`aiDraft.undo.${top.how && top.how !== "draft" ? top.how : "rewrite"}`);
  const item = (
    <ButtonGroupItem
      className="text-foreground"
      aria-label={what}
      data-testid="ai-strip-undo"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        // from the field over a strip: the row goes back to the strip first, so Undo acts on it as it would there
        if (s.phase !== "strip") closeRow(s.key);
        undoCommit(s.key);
      }}
    />
  );
  const button = (
    <Tooltip>
      <TooltipTrigger render={item}>
        <Undo2 aria-hidden />
        {t("common.undo")}
      </TooltipTrigger>
      <TooltipContent>{what}</TooltipContent>
    </Tooltip>
  );
  return alone ? <ButtonGroup className="h-7" aria-label={t("aiDraft.commands")}>{button}</ButtonGroup> : button;
}

/**
 * Shorter and Warmer, folded into one menu where the line can't hold them beside Undo, Regenerate and the status. Plan 162
 * (after ai162-r01): Regenerate, the rewrite most asked for, stays a button of its own at every width.
 */
function RewriteMenu({ s }: { s: AiSession }) {
  return (
    <DropdownMenu>
      {/* the group's last item when it shows: no divider after it */}
      <DropdownMenuTrigger render={<ButtonGroupItem className="hidden text-foreground @max-[30rem]/strip:inline-flex @max-[30rem]/strip:border-e-0" data-testid="ai-strip-rewrite" />}>
        {t("aiDraft.rewrite")}
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      {/* plan 162 (after ai162-r02): a rewrite chosen here gives the keys to the draft, as the wide buttons do; the menu
          handing them back to its trigger lost them (the commands are redrawn while it writes) */}
      <DropdownMenuContent align="start" className="w-max" data-testid="ai-strip-rewrite-menu" >
        {(["shorter", "warmer"] as const).map((how) => (
          <DropdownMenuItem key={how} data-testid={`ai-strip-rewrite-${how}`} onClick={() => refine(s.key, how)}>
            <span className="whitespace-nowrap">{t(`aiDraft.${how}`)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Strip({ s }: { s: AiSession & { strip: AiStrip } }) {
  const toText = useDrafts((state) => state.drafts[s.key]?.toText ?? "");
  const { strip } = s;
  // plan 163: a fill's only rewrite is Fill again (Shorter or Warmer would rewrite the user's own words)
  const filled = strip.fill !== undefined;
  return (
    // plan 161, pass 3: the commands, and the provenance at the line's end, as on every AI surface. Plan 162: the commands
    // are one group; narrow, the rewrites fold into Rewrite ▾ in it. Plan 163: what was asked is in the provenance's popover
    <div className="@container/strip flex min-w-0 flex-1 flex-col" data-testid="ai-strip" data-edited={strip.edited || undefined} data-stopped={strip.stopped || undefined} data-fill={filled || undefined}>
      <div className={cn(line, "flex-nowrap py-[5px]")}>
        <ButtonGroup className="h-7" aria-label={t("aiDraft.commands")} data-testid="ai-strip-commands">
          <UndoButton s={s} />
          {filled ? (
            <ButtonGroupItem className="border-e-0 text-foreground" data-testid="ai-strip-regenerate" onClick={() => refine(s.key, "regenerate")}>
              {t("aiDraft.fillAgain")}
            </ButtonGroupItem>
          ) : (
            <>
              {(["regenerate", "shorter", "warmer"] as const).map((how) => (
                <ButtonGroupItem key={how} className={cn("text-foreground", how !== "regenerate" && "@max-[30rem]/strip:hidden", how === "warmer" && "border-e-0")} data-testid={`ai-strip-${how}`} onClick={() => refine(s.key, how)}>
                  {t(`aiDraft.${how}`)}
                </ButtonGroupItem>
              ))}
              <RewriteMenu s={s} />
            </>
          )}
        </ButtonGroup>
        <StatusPopover s={s} strip={strip} toText={toText} />
      </div>
      {/* the same notes the Status had, in the same place: the row keeps its height across the commit */}
      {s.confirmFailed && <p className="w-full pb-1.5 text-xs text-muted-foreground">{t("aiDraft.confirmFailed")}</p>}
      {s.everyone > 0 && (
        <Button type="button" variant="link-secondary" className="mb-1.5 w-fit text-xs" data-testid="ai-include-everyone" onClick={() => void includeEveryone(s.key)}>
          {t("aiDraft.includeEveryone", { count: s.everyone })}
        </Button>
      )}
    </div>
  );
}

function stripChecks(strip: AiStrip): string[] {
  const specifics = strip.checks.specifics.map((f) => f.text);
  const left = strip.fill ? strip.fill.fills.filter((f) => !f).length : 0;
  return [
    ...(specifics.length ? [t("aiDraft.check.specifics", { items: specifics.slice(0, 3).join(", "), count: specifics.length })] : []),
    ...(left ? [t("aiDraft.check.fillLeft", { count: left })] : []),
    ...(strip.cutOff ? [t("aiDraft.check.cutOff")] : []),
    ...(strip.oneTap ? [t("aiDraft.check.oneTap")] : []),
    ...(strip.readFailed ? [t("aiDraft.check.readFailed")] : []),
  ];
}

function Status({ s }: { s: AiSession }) {
  const local = useApp((state) => writingTarget(state.settings?.ai).local);
  const run = s.run;
  // plan 161, pass 2: a rewrite says so, over the text it keeps in place until the new one is in
  const rewriting = run?.spec.kind === "refine";
  // plan 163: reading what was typed (the fast model), filling its gaps, or writing
  const filling = run?.spec.kind === "fill" ? run.spec.fill?.gaps.length ?? 0 : 0;
  const text = s.phase === "reading" ? t("aiDraft.reading") : run?.slow ? (local && !run.streaming ? t("aiDraft.loadingModel") : t("aiDraft.stillWriting")) : filling ? t("aiDraft.filling", { count: filling }) : rewriting ? t("aiDraft.rewriting") : t("aiDraft.writing");
  return (
    // plan 163: what was asked is in the body (dimmed while it's read), not in a line here
    <div className="flex min-w-0 flex-1 flex-col">
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

/** Plan 161, pass 2: the one AI error (ai-card), in the row: plain words, never an address, and the row's own answers. */
function ErrorLine({ s }: { s: AiSession }) {
  const ai = useApp((state) => state.settings?.ai);
  const e = s.error;
  if (!e) return null;
  // the task's own provider, which can differ from Settings' first row (Codex review)
  const copy = aiErrorCopy({ message: e.message, kind: e.kind, key: e.key }, errorTarget(writingTarget(ai).provider, ai));
  return (
    <div className={cn(line, "text-foreground")} data-testid="ai-error" data-kind={e.kind}>
      <AiErrorNotice
        copy={copy}
        textTestId="ai-error-text"
        actions={
          <>
            {e.partial && (
              <Button type="button" variant="outline" size="sm" data-testid="ai-error-insert" onClick={() => placePartial(s.key)}>
                {t("aiDraft.insert")}
              </Button>
            )}
            {e.retry && (
              <Button type="button" variant="outline" size="sm" data-ai-default data-testid="ai-error-retry" onClick={() => retry(s.key)}>
                {t("aiDraft.tryAgain")}
              </Button>
            )}
            {copy.settings && (
              <Button type="button" variant="ghost" size="sm" className={quiet} data-testid="ai-error-settings" onClick={() => { closeRow(s.key, { keepDraft: true }); openSettings(); }}>
                {t("ai.error.settings")}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" className={quiet} data-testid="ai-error-close" onClick={() => (e.partial ? discard(s.key) : closeRow(s.key))}>
              {e.partial ? t("aiDraft.discard") : t("common.close")}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Plan 161, pass 2: a run that would replace text typed since the AI wrote it asks first, in the strip. */
function Confirm({ s }: { s: AiSession }) {
  return (
    <div className={line} data-testid="ai-confirm" role="alert">
      <span className="min-w-0">
        <span className="text-foreground" data-testid="ai-confirm-text">{t("aiDraft.confirm.title")}</span> {t("aiDraft.confirm.help")}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-foreground">
        <Button type="button" variant="outline" size="sm" data-ai-default data-testid="ai-confirm-replace" onClick={() => confirmReplace(s.key)}>
          {t("aiDraft.confirm.replace")}
        </Button>
        <Button type="button" variant="ghost" size="sm" className={quiet} data-testid="ai-confirm-keep" onClick={() => keepEdits(s.key)}>
          {t("aiDraft.confirm.keep")}
        </Button>
      </span>
    </div>
  );
}

function Choice({ s }: { s: AiSession }) {
  const c = s.choice;
  if (!c) return null;
  const notes = c.reason === "notes";
  // plan 163: over an instruction typed into while it wrote, Replace is offered too: the draft was meant for its place
  const replaceable = offersReplace(s);
  return (
    <div className={line} data-testid="ai-choice" data-reason={c.reason}>
      <span data-testid="ai-choice-text">{t(notes ? "aiDraft.choice.notes" : "aiDraft.choice.ready")}</span>
      {c.writtenFor && <span data-testid="ai-written-for">{t("aiDraft.choice.writtenFor", { name: c.writtenFor })}</span>}
      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-1">
        {replaceable ? (
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
      {/* plan 162 (after ai162-r02): said as a warning, its glyph first (it read as grey text) */}
      <span className="flex min-w-0 items-start gap-1.5 text-foreground" data-testid="ai-gaps-text">
        <TriangleAlert aria-hidden className="mt-0.5 size-[1.15em] shrink-0" />
        <span>{t("aiDraft.gaps.text", { count: gaps.length, gaps: gaps.join(" ") })}</span>
      </span>
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
  // plan 163: still reading what was typed, working out who it's for, or asking: what's there is the user's own words
  const working = s.phase === "reading" || s.phase === "resolving" || s.phase === "question" || s.phase === "input";
  return (
    <div className={line} data-testid="ai-guard" role="alert">
      <span className="text-foreground">{t(writing ? "aiDraft.guard.writing" : working ? "aiDraft.guard.working" : "aiDraft.guard.ready")}</span>
      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-1">
        <Button type="button" variant="outline" size="xs" className="font-normal" data-ai-default data-testid="ai-guard-send" onClick={() => discardAndSend(s.key)}>
          {t(writing || working ? "aiDraft.guard.stopSend" : "aiDraft.guard.discardSend")}
        </Button>
        <Button type="button" variant="ghost" size="xs" className={quiet} data-testid="ai-guard-keep" onClick={() => keepWriting(s.key)}>
          {t("aiDraft.guard.keep")}
        </Button>
      </span>
    </div>
  );
}

/** Plan 163: the row asks who it's for (nothing to write to yet): Write, or ⌘J, once someone's in To. */
function Who({ s }: { s: AiSession }) {
  return (
    <div className={line} data-testid="ai-who-row">
      {s.who && <span data-testid="ai-who">{t("aiDraft.who")}</span>}
      {s.lookingUp && <span data-testid="ai-looking-up">{t("aiDraft.lookingUp")}</span>}
      {s.who && (
        <Button type="button" variant="outline" size="sm" className="ml-auto shrink-0" data-ai-default data-testid="ai-who-write" onMouseDown={(e) => e.preventDefault()} onClick={() => void submit(s.key)}>
          {t("aiDraft.whoWrite")}
          <Shortcut keys="mod+j" className="ml-0.5" />
        </Button>
      )}
    </div>
  );
}

/** The row, whichever state it's in. */
export function AiRow({ draftKey }: { draftKey: string }) {
  const s = useAiDraft((state) => state.sessions[draftKey]);
  const c = useController(draftKey);
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
  // and kept there when the window shrinks under it, while the strip is up and the composer's top is on screen (someone who
  // scrolled away to read stays where they are)
  const stripUp = s?.phase === "strip";
  useEffect(() => {
    if (!stripUp) return;
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const form = rootRef.current?.closest<HTMLElement>("form[data-draft-key]");
        const scroller = form?.closest<HTMLElement>("[data-reader-scroller]");
        if (!form || !scroller) return;
        // only a composer whose top is on screen: one scrolled out of view, above or below, is left there (Codex review)
        const top = form.getBoundingClientRect().top, view = scroller.getBoundingClientRect();
        if (top < view.top || top >= view.bottom) return;
        keepInView(form, scroller, 16, () => form.getBoundingClientRect().height);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [stripUp]);
  // asked for: the field, or the row's default choice. Programmatic, so no ring (plan 54)
  const focus = s?.focus ?? 0;
  useLayoutEffect(() => {
    if (!takeFocusRequest(draftKey, focus)) return;
    rootRef.current?.querySelector<HTMLElement>("[data-ai-default]")?.focus({ preventScroll: true });
  }, [draftKey, focus]);
  if (!s) return null;
  const content = (() => {
    if (s.guard) return <Guard s={s} />;
    if (s.confirm && s.strip) return <Confirm s={s} />;
    switch (s.phase) {
      case "input":
        // plan 163: opened for AI and nothing more: no row (the body says what to do); over a strip, the strip
        if (s.strip) return <Strip s={s as AiSession & { strip: AiStrip }} />;
        return s.who || s.lookingUp ? <Who s={s} /> : null;
      case "resolving":
        return s.lookingUp ? <Who s={s} /> : <Status s={s} />;
      case "reading":
        return <Status s={s} />;
      case "question":
        return <Question s={s} />;
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
      {content && <Frame draftKey={draftKey}>{content}</Frame>}
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
  const hintRef = useRef<HTMLSpanElement>(null);
  // plan 163: ⌘J opened this composer for AI: the empty body says what to do here (its own placeholder otherwise)
  const isNew = useDrafts((state) => state.drafts[draftKey]?.mode === "new");
  const hint = primed(s) ? t(isNew ? "aiDraft.bodyHint.new" : "aiDraft.bodyHint.reply", { keys: shortcutText("mod+j") }) : null;
  useLayoutEffect(() => {
    const host = hintRef.current?.parentElement;
    if (!host || !hint) return;
    host.setAttribute("data-ai-hint", "");
    host.style.setProperty("--ai-hint", JSON.stringify(hint));
    return () => {
      host.removeAttribute("data-ai-hint");
      host.style.removeProperty("--ai-hint");
    };
  }, [hint]);
  // plan 163: the instruction in the body gives way to the stream once its first words are in
  const streaming = mode === "replacing" && s?.run?.streaming === true;
  useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || !streaming) return;
    host.setAttribute("data-ai-streaming", "");
    return () => host.removeAttribute("data-ai-streaming");
  }, [streaming]);
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
  // the editor's cell shows it: without its placeholder or caret, its old text dimmed while it's rewritten, tight above it below
  useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || !mode) return;
    host.setAttribute("data-ai-overlay", mode);
    return () => host.removeAttribute("data-ai-overlay");
  }, [mode]);
  // under the text, not in the row: a line added above the body at commit would move every word it just wrote
  const checks = s?.phase === "strip" && s.strip ? stripChecks(s.strip) : [];
  if (hint) return <span ref={hintRef} hidden data-testid="ai-body-hint" />;
  if (!mode) {
    if (!checks.length) return null;
    return (
      <p className="px-3.5 pb-1 text-xs text-muted-foreground [grid-area:2/1]" data-testid="ai-strip-check">
        {checks.join(" ")}
      </p>
    );
  }
  // plan 161, pass 2: a rewrite draws nothing over the text: it stays, dimmed, until the new one replaces it in one step
  if (mode === "rewriting") return <div ref={rootRef} hidden data-testid="ai-rewriting" />;
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
