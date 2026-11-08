import { SNIPPET_HTML_MAX, SNIPPET_TEXT_MAX, SNIPPET_VARIABLES, type Snippet, type SnippetFields } from "@terno/core";
import { schema } from "@terno/richtext";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Input } from "@terno/ui/components/input";
import { cn } from "@terno/ui/lib/utils";
import { Braces, ChevronDown, ChevronLeft, Trash2 } from "@terno/ui/icons";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { openLink } from "../mail-body";
import { beginEdit, flushSave, keepMine, loadTheirs, queueSave, retrySave, unsavedContent, useSaveStatus, useSnippets } from "~/lib/snippets";
import { closeSnippetEditor } from "~/lib/snippet-editor-state";
import { removeSnippet } from "../settings/snippets-tab";
import { EMPTY_FORMAT, registerController, type ComposerController, type FormatState } from "./controller";
import { COMMANDS, createEditor, formatState, isEmpty, linkAt, newState, sameFormat, serialize, setAlign, setMark } from "./editor";
import { FormatBar, LinkPopover, type LinkDraft } from "./rich";
import { snippetDoc, withoutImages } from "./snippets";

/**
 * Plan 93: Settings → Snippets' editor. The composer's own editor and format
 * bar on a snippet (no draft behind it: no ghost text, no files), autosaved
 * like a draft through lib/snippets (one save in flight, the latest wins,
 * flushed when the editor goes).
 */

const field = "h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent";

function Body({ editorKey, initial, onChange, viewRef }: { editorKey: string; initial: Pick<Snippet, "bodyHtml" | "bodyText">; onChange: () => void; viewRef: React.RefObject<EditorView | null> }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const openLinkRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    let format: FormatState = EMPTY_FORMAT;
    const listeners = new Set<() => void>();
    let frame = 0;
    const publish = () => {
      frame = 0;
      const next = formatState(view.state, true);
      if (sameFormat(next, format)) return;
      format = next;
      for (const l of listeners) l();
    };
    const placeholder = t("snippets.bodyPlaceholder");
    const editor = createEditor(mountRef.current!, {
      state: newState(snippetDoc(initial.bodyHtml, initial.bodyText)),
      editable: () => true,
      attributes: { role: "textbox", tabindex: "0", "aria-multiline": "true", "aria-label": t("snippets.body"), "aria-placeholder": placeholder, "data-placeholder": placeholder, "data-testid": "snippet-body", spellcheck: "true", class: "rt-body type-body min-h-40 px-3 py-2.5 outline-none" },
      hooks: {
        onChange: () => {
          view.dom.classList.toggle("is-empty", isEmpty(view.state.doc));
          changed.current();
        },
        onUpdate: () => {
          if (!frame) frame = requestAnimationFrame(publish);
        },
        onLink: () => openLinkRef.current(),
        openLink,
      },
    });
    const view = editor.view;
    viewRef.current = view;
    view.dom.classList.toggle("is-empty", isEmpty(view.state.doc));
    format = formatState(view.state, true);
    const run = (cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean, focus = true) => {
      cmd(view.state, view.dispatch);
      if (focus) view.focus();
    };
    const controller: ComposerController = {
      run: (command) => run(COMMANDS[command]),
      setFont: (v) => run(setMark(schema.marks.font, v)),
      setSize: (v) => run(setMark(schema.marks.size, v)),
      setColor: (v, f) => run(setMark(schema.marks.color, v), f),
      setHighlight: (v, f) => run(setMark(schema.marks.highlight, v), f),
      setAlign: (v) => run(setAlign(v)),
      openLink: () => openLinkRef.current(),
      dropFiles: () => {},
      dropCaret: () => {},
      insertSnippet: () => null,
      snapshot: () => serialize(withoutImages(view.state.doc)),
      // no AI in a snippet's editor
      insertGenerated: () => null,
      undoGenerated: () => null,
      restoreGenerated: () => null,
      selectText: () => false,
      docToken: () => view.state.doc,
      subscribeDoc: () => () => {},
      empty: () => false,
      dismissGhost: () => {},
      focus: () => view.focus(),
      dom: view.dom as HTMLElement,
      getState: () => format,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const unregister = registerController(editorKey, controller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unregister();
      viewRef.current = null;
      editor.destroy();
    };
    // the editor is made once per snippet (and key): its later content is its own
  }, [editorKey]);

  openLinkRef.current = () => {
    const view = viewRef.current;
    if (!view) return;
    const existing = linkAt(view.state);
    const { from, to, $from, $to } = view.state.selection;
    const range = existing ?? { from, to };
    setLink({ ...range, text: view.state.doc.textBetween(range.from, range.to), href: existing?.href ?? "", textEditable: existing !== null || $from.parent === $to.parent, editing: existing !== null });
  };
  const closeLink = () => {
    flushSync(() => setLink(null));
    viewRef.current?.focus();
  };

  return (
    <div className="relative">
      <div ref={mountRef} className="relative" />
      {link && viewRef.current && <LinkPopover view={viewRef.current} draft={link} onClose={closeLink} canEdit={() => true} palette={false} />}
    </div>
  );
}

function Status({ id, tooLong, onTheirs }: { id: string; tooLong: boolean; onTheirs: () => void }) {
  const status = useSaveStatus((s) => s[id] ?? "idle");
  if (tooLong) return <p role="alert" className="text-xs text-destructive-ink" data-testid="snippet-status">{t("snippets.error.bodyTooLong")}</p>;
  if (status === "conflict")
    return (
      <div role="alert" className="flex items-center gap-2 text-xs" data-testid="snippet-conflict">
        <span className="text-muted-foreground">{t("snippets.conflict")}</span>
        <Button variant="ghost" size="xs" onClick={() => keepMine(id)} data-testid="snippet-keep-mine">{t("snippets.keepMine")}</Button>
        <Button variant="ghost" size="xs" onClick={onTheirs} data-testid="snippet-load-theirs">{t("snippets.loadTheirs")}</Button>
      </div>
    );
  if (status === "failed")
    return (
      <div role="alert" className="flex items-center gap-2 text-xs" data-testid="snippet-status">
        <span className="text-destructive-ink">{t("snippets.status.failed")}</span>
        <Button variant="ghost" size="xs" onClick={() => retrySave(id)} data-testid="snippet-retry">{t("snippets.retry")}</Button>
      </div>
    );
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="snippet-status" data-status={status}>
      {status === "saving" ? t("snippets.status.saving") : status === "saved" ? t("snippets.status.saved") : ""}
    </p>
  );
}

/** The snippet being edited (or a new one, `fresh`, created on its first change). */
export default function SnippetEditor({ id, fresh, selectName }: { id: string; fresh: boolean; selectName: boolean }) {
  const stored = useSnippets((s) => s.list?.find((x) => x.id === id) ?? null);
  // what the editor started from; "Load theirs" starts it again (a new key remounts the text)
  // (what this editor wrote and couldn't save yet comes back over it: Codex code review 2)
  const [start, setStart] = useState<{ snippet: Snippet | null; n: number }>(() => {
    const unsaved = unsavedContent(id);
    return { snippet: unsaved ? { ...(stored ?? { id, createdAt: 0, updatedAt: 0 }), ...unsaved } : stored, n: 0 };
  });
  const initial = start.snippet;
  const [name, setName] = useState(initial?.name ?? "");
  const [fills, setFills] = useState(() => ({ subject: initial?.subject ?? "", to: initial?.to ?? "", cc: initial?.cc ?? "", bcc: initial?.bcc ?? "" }));
  const [tooLong, setTooLong] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const base = useId();
  const editorKey = `snippet:${id}:${start.n}`;
  const latest = useRef({ name, fills });
  latest.current = { name, fills };

  // its saves are based on what it opened (a new one has none yet)
  // (on the stored version when there is one, whatever opened it: Codex code review 6)
  useState(() => beginEdit(id, stored?.updatedAt ?? null));
  // leaving (back, another tab, Settings closing) saves what's waiting now
  useEffect(() => () => flushSave(id), [id]);
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    if (fresh) el.focus();
    else if (selectName) {
      el.focus();
      el.select();
    }
  }, [fresh, selectName]);

  const save = () => {
    const view = viewRef.current;
    const body = view ? serialize(withoutImages(view.state.doc)) : { html: initial?.bodyHtml ?? "", text: initial?.bodyText ?? "" };
    const over = body.html.length > SNIPPET_HTML_MAX || body.text.length > SNIPPET_TEXT_MAX;
    setTooLong(over);
    if (over) return;
    const { name, fills } = latest.current;
    const fields: SnippetFields = { name: name.trim().slice(0, 80), bodyHtml: body.html, bodyText: body.text, subject: fills.subject.trim(), to: fills.to.trim(), cc: fills.cc.trim(), bcc: fills.bcc.trim() };
    // a new snippet with nothing in it isn't one yet
    if (fresh && !stored && !fields.name && !fields.bodyText.trim() && !fields.subject && !fields.to && !fields.cc && !fields.bcc) return;
    queueSave(id, fields);
  };

  const insertVariable = (variable: string) => {
    const view = viewRef.current;
    if (!view) return;
    const token = `{${variable}}`;
    const { from, to } = view.state.selection;
    const tr = view.state.tr.insertText(token, from, to);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + token.length)));
    view.focus();
  };

  const theirs = async () => {
    const next = await loadTheirs(id);
    if (!next) return closeSnippetEditor();
    setName(next.name);
    setFills({ subject: next.subject, to: next.to, cc: next.cc, bcc: next.bcc });
    setStart((s) => ({ snippet: next, n: s.n + 1 }));
  };

  const fillRow = (key: keyof typeof fills, label: string) => (
    <div className="flex items-center gap-3 py-0.5">
      <label htmlFor={`${base}-${key}`} className="w-16 shrink-0 text-sm text-muted-foreground">{label}</label>
      <Input
        id={`${base}-${key}`}
        data-testid={`snippet-${key}`}
        className={field}
        value={fills[key]}
        onChange={(e) => {
          const next = { ...fills, [key]: e.target.value };
          setFills(next);
          latest.current = { name, fills: next };
          save();
        }}
        autoComplete="off"
        spellCheck={key === "subject"}
      />
    </div>
  );

  return (
    <div className="min-w-0" data-testid="snippet-editor" data-snippet-id={id}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => closeSnippetEditor()} data-testid="snippet-back">
          <ChevronLeft /> {t("settings.tab.snippets")}
          <span className="sr-only">, {t("snippets.back")}</span>
        </Button>
        <Status id={id} tooLong={tooLong} onTheirs={() => void theirs()} />
      </div>
      <div className="hairline-divide card-group">
        <div className="flex items-center gap-3 px-4 py-1.5">
          <label htmlFor={`${base}-name`} className="w-16 shrink-0 text-sm text-muted-foreground">{t("snippets.name")}</label>
          <Input
            ref={nameRef}
            id={`${base}-name`}
            data-testid="snippet-name"
            className={cn(field, "font-medium")}
            value={name}
            maxLength={80}
            placeholder={t("snippets.namePlaceholder")}
            onChange={(e) => {
              setName(e.target.value);
              latest.current = { name: e.target.value, fills };
              save();
            }}
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-1 px-2 pt-2">
          <FormatBar draftKey={editorKey} className="min-w-0 flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} data-testid="snippet-variable" className="shrink-0 text-muted-foreground hover:text-foreground">
                  <Braces /> {t("snippets.variable.insert")}
                  <ChevronDown aria-hidden />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-48" finalFocus={false}>
              {SNIPPET_VARIABLES.map((v) => (
                <DropdownMenuItem key={v} onClick={() => insertVariable(v)} data-testid={`snippet-variable-${v}`}>
                  <span className="flex-1">{t(`snippets.variable.${v}`)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{`{${v}}`}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Body key={editorKey} editorKey={editorKey} initial={initial ?? { bodyHtml: "", bodyText: "" }} onChange={save} viewRef={viewRef} />
      </div>
      <p className="mt-1.5 px-1 text-xs text-muted-foreground">{t("snippets.variables.help")}</p>

      {/* starts open when one of them is filled in */}
      <Collapsible className="mt-5" defaultOpen={Object.values(fills).some((v) => v.trim() !== "")}>
        <CollapsibleTrigger data-testid="snippet-fills-toggle" className="w-auto gap-1 rounded-sm px-1 text-xs font-semibold text-muted-foreground hover:text-foreground [&_svg]:size-[1.15em]">
          {t("snippets.alsoFills")}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-1.5 hairline-divide card-group px-4">
            {fillRow("subject", t("compose.subject"))}
            {fillRow("to", t("compose.to"))}
            {fillRow("cc", t("compose.cc"))}
            {fillRow("bcc", t("compose.bcc"))}
          </div>
          <p className="mt-1.5 px-1 text-xs text-muted-foreground">{t("snippets.alsoFills.hint")}</p>
        </CollapsiblePanel>
      </Collapsible>

      <div className="mt-6 flex items-center justify-between">
        {stored ? (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground hover:text-destructive-ink"
            data-testid="snippet-delete"
            onClick={() => {
              closeSnippetEditor();
              void removeSnippet(stored);
            }}
          >
            <Trash2 /> {t("snippets.delete")}
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={() => closeSnippetEditor()} data-testid="snippet-done">
          {t("snippets.done")}
        </Button>
      </div>
    </div>
  );
}
