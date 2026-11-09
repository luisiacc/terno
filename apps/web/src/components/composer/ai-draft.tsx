import { parseAddressList } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { ButtonGroup, ButtonGroupItem } from "@terno/ui/components/button-group";
import { CloseButton } from "@terno/ui/components/close-button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronDown, Pencil, Undo2 } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { modelName, providerLabel, writingTarget } from "~/lib/ai";
import { answer, closeRow, commitHeld, confirmReplace, discard, discardAndSend, editInstruction, includeEveryone, keepEdits, keepWriting, noteBody, place, placePartial, previewMode, previewText, recallInstruction, refine, retry, setInstruction, stop, submit, subscribePreview, takeFocusRequest, undoCommit, useAiDraft, type AiSession, type AiStrip } from "~/lib/ai-draft";
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
 * Plan 161, pass 2: the strip's status is the one way into what the AI used. Pass 3: it is the one provenance control every AI
 * surface has (`AiProvenance`), at the command line's end: "Written with AI ▾" opens the voice ("In your voice with Arjun"),
 * what it read, and the model; the instruction has its own line now, so the popover doesn't hold it.
 */
function StatusPopover({ strip, toText }: { strip: AiStrip; toText: string }) {
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
      <p className="text-xs text-muted-foreground">{t("aiDraft.language.change")}</p>
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
  const what = !top || (s.strip?.stack.length ?? 0) <= 1 ? t("aiDraft.undo.draft") : t(`aiDraft.undo.${top.how && top.how !== "draft" ? top.how : "rewrite"}`);
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
 * Plan 161, pass 3: what was asked, in the user's words, on its own line above the commands: where it was typed, while
 * it's written, and after. Plan 162 (after ai162-r02): one line again (two lines and the commands took ~96 px over a short
 * draft at 1100, all four Codex reports), and the whole of it a click away: cut, the words are a disclosure that opens to
 * every line (its title and name hold them too). "Edit instruction" stays right after them, a 28 px control.
 */
function InstructionLine({ text, onEdit }: { text: string; onEdit: (() => void) | null }) {
  const quoted = t("aiDraft.instruction.quoted", { instruction: text });
  const line = useRef<HTMLParagraphElement>(null);
  const words = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  // the line is the one element that stays (the words move into a button once they're cut): it's what's watched, and the
  // words are read as they are when it changes
  useLayoutEffect(() => {
    const at = line.current;
    if (!at || open) return;
    const measure = () => {
      const el = words.current;
      if (el) setCut(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(at);
    return () => ro.disconnect();
  }, [text, open]);
  const body = (
    <span ref={words} className={cn("block min-w-0 text-start", open ? "wrap-anywhere whitespace-normal" : "truncate")} data-testid="ai-strip-instruction-text">
      {quoted}
    </span>
  );
  return (
    <p ref={line} className="flex min-h-[38px] min-w-0 items-start gap-1.5 py-[9px] text-sm leading-5 text-foreground" data-testid="ai-strip-instruction" data-open={open || undefined}>
      {cut || open ? (
        <button type="button" className="min-w-0 cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" title={open ? undefined : quoted} aria-expanded={open} aria-label={open ? undefined : quoted} data-testid="ai-strip-instruction-toggle" onClick={() => setOpen((o) => !o)}>
          {body}
        </button>
      ) : (
        <span className="min-w-0" title={quoted}>{body}</span>
      )}
      {/* while it writes, its place is held (nothing to edit yet), so the line is the same before and after the commit */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        // plan 162 (after ai162-r02): bounded, as every "edit what the AI read" is (grey text, it read as a hint)
        className={cn("-my-1 shrink-0 text-foreground", !onEdit && "invisible")}
        aria-hidden={onEdit ? undefined : true}
        tabIndex={onEdit ? undefined : -1}
        data-testid={onEdit ? "ai-strip-edit-instruction" : undefined}
        onClick={onEdit ?? undefined}
      >
        <Pencil aria-hidden />
        {t("aiDraft.instruction.edit")}
      </Button>
    </p>
  );
}

/** The instruction a run is writing from, as its strip will show it: a rewrite keeps the strip's own (Shorter isn't the user's words). */
function runInstruction(s: AiSession): string {
  const spec = s.run?.spec ?? s.lastSpec;
  if (!spec) return "";
  if (spec.kind === "refine" && !spec.regenerate) return s.run?.prior?.instruction ?? "";
  return spec.instruction;
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
      <DropdownMenuContent align="start" className="w-max" data-testid="ai-strip-rewrite-menu">
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
  return (
    // plan 161, pass 3: the instruction on its own line, then the commands, and the provenance at the line's end, as on
    // every AI surface. Plan 162: the commands are one group; narrow, the rewrites fold into Rewrite ▾ in it
    <div className="@container/strip flex min-w-0 flex-1 flex-col" data-testid="ai-strip" data-edited={strip.edited || undefined} data-stopped={strip.stopped || undefined}>
      {strip.instruction && <InstructionLine text={strip.instruction} onEdit={() => editInstruction(s.key)} />}
      <div className={cn(line, "flex-nowrap py-[5px]")}>
        <ButtonGroup className="h-7" aria-label={t("aiDraft.commands")} data-testid="ai-strip-commands">
          <UndoButton s={s} />
          {(["regenerate", "shorter", "warmer"] as const).map((how) => (
            <ButtonGroupItem key={how} className={cn("text-foreground", how !== "regenerate" && "@max-[30rem]/strip:hidden", how === "warmer" && "border-e-0")} data-testid={`ai-strip-${how}`} onClick={() => refine(s.key, how)}>
              {t(`aiDraft.${how}`)}
            </ButtonGroupItem>
          ))}
          <RewriteMenu s={s} />
        </ButtonGroup>
        <StatusPopover strip={strip} toText={toText} />
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
  return [
    ...(specifics.length ? [t("aiDraft.check.specifics", { items: specifics.slice(0, 3).join(", "), count: specifics.length })] : []),
    ...(strip.cutOff ? [t("aiDraft.check.cutOff")] : []),
    ...(strip.oneTap ? [t("aiDraft.check.oneTap")] : []),
  ];
}

function Status({ s }: { s: AiSession }) {
  const local = useApp((state) => writingTarget(state.settings?.ai).local);
  const run = s.run;
  // plan 161, pass 2: a rewrite says so, over the text it keeps in place until the new one is in
  const rewriting = run?.spec.kind === "refine";
  const text = run?.slow ? (local && !run.streaming ? t("aiDraft.loadingModel") : t("aiDraft.stillWriting")) : rewriting ? t("aiDraft.rewriting") : t("aiDraft.writing");
  const instruction = runInstruction(s);
  return (
    // plan 161, pass 3: the instruction stays where it was typed, above what's happening, as the strip will have it
    <div className="flex min-w-0 flex-1 flex-col">
      {instruction && <InstructionLine text={instruction} onEdit={null} />}
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
  const fresh = threaded ? t("aiDraft.placeholder.reply") : t("aiDraft.placeholder.new");
  // over a strip: what should change, or (its instruction, to edit) what the draft should say
  const placeholder = s.strip ? (s.rewrite ? fresh : t("aiDraft.placeholder.refine")) : notes ? t("aiDraft.placeholder.notes") : fresh;
  return (
    <>
      {/* one line that grows to show all it holds (plan 161: a long instruction was cut mid-word); Return still writes */}
      <textarea
        id={id}
        data-testid="ai-row-input"
        // plan 162 (after ai162-r02): named for what it holds (its label, "AI", said only whose)
        aria-label={t("aiDraft.fieldName")}
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
    rootRef.current?.querySelector<HTMLElement>("[data-ai-default], [data-testid=ai-row-input]")?.focus({ preventScroll: true });
  }, [draftKey, focus]);
  if (!s) return null;
  const content = (() => {
    if (s.guard) return <Guard s={s} />;
    if (s.confirm && s.strip) return <Confirm s={s} />;
    switch (s.phase) {
      case "input":
      case "resolving":
        return (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5">
            <Field s={s} id={inputId} />
            {/* plan 161, pass 2: over a strip, its Undo stays in reach while the field is open */}
            {s.strip && s.phase === "input" && <span className="mt-[5px] shrink-0 self-start"><UndoButton s={s} alone /></span>}
            {s.who && <p className="mb-1.5 w-full text-xs text-muted-foreground" data-testid="ai-who">{t("aiDraft.who")}</p>}
            {s.lookingUp && <p className="mb-1.5 w-full text-xs text-muted-foreground" data-testid="ai-looking-up">{t("aiDraft.lookingUp")}</p>}
          </div>
        );
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
  // the editor's cell shows it: without its placeholder or caret, its old text dimmed while it's rewritten, tight above it below
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
