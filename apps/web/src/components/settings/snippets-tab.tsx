import { snippetPreview, type Snippet } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Pencil, Plus, Trash2 } from "@terno/ui/icons";
import { lazy, Suspense, useEffect } from "react";
import { isMac } from "~/lib/select";
import { deleteSnippet, loadSnippets, newSnippetId, useSnippets } from "~/lib/snippets";
import { openSnippetEditor, useSnippetEditor } from "~/lib/snippet-editor-state";
import { SettingsGroup } from "./parts";

// the composer's editor: its chunk loads when a snippet is opened, not with Settings
const SnippetEditor = lazy(() => import("../composer/snippet-editor"));

export const snippetKeys = () => (isMac ? "⌘;" : "Ctrl+;");
const paletteKeys = () => (isMac ? "⌘K" : "Ctrl+K");

/** What a snippet fills in besides its text ("Subject and To"). */
function fillsOf(s: Snippet): string | null {
  const fields = [s.subject && t("compose.subject"), s.to && t("compose.to"), s.cc && t("compose.cc"), s.bcc && t("compose.bcc")].filter(Boolean) as string[];
  return fields.length ? t("snippets.fills", { fields: formatList(fields) }) : null;
}

function SnippetRow({ snippet }: { snippet: Snippet }) {
  const name = snippet.name || t("snippets.untitled");
  const preview = snippetPreview(snippet);
  const fills = fillsOf(snippet);
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-testid="settings-snippet" data-snippet-id={snippet.id}>
      {/* a click anywhere on the row edits it; the keyboard has the Edit button */}
      <div className="min-w-0 flex-1 cursor-default" onClick={() => openSnippetEditor(snippet.id)}>
        <p className={snippet.name ? "truncate text-sm font-medium" : "truncate text-sm font-medium text-muted-foreground"}>{name}</p>
        {(preview || fills) && <p className="truncate text-xs text-muted-foreground">{[preview, fills].filter(Boolean).join(" · ")}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t("snippets.edit", { name })} data-testid="settings-snippet-edit" onClick={() => openSnippetEditor(snippet.id)}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive-ink" aria-label={t("snippets.deleteNamed", { name })} data-testid="settings-snippet-delete" onClick={() => void deleteSnippet(snippet)}>
        <Trash2 />
      </Button>
    </div>
  );
}

/** Settings → Snippets: every snippet, edited in place (the list gives way to the editor), deleted with Undo. */
export function SnippetsTab() {
  const list = useSnippets((s) => s.list);
  const editor = useSnippetEditor();
  useEffect(loadSnippets, []);
  if (editor.editing) {
    return (
      <Suspense fallback={<div className="h-64" aria-hidden />}>
        <SnippetEditor key={editor.editing} id={editor.editing} fresh={editor.fresh} selectName={editor.selectName} />
      </Suspense>
    );
  }
  return (
    <div data-testid="snippets-tab">
      <SettingsGroup title={t("settings.tab.snippets")} footer={list?.length ? t("snippets.footer", { keys: snippetKeys(), palette: paletteKeys(), example: "{first_name}" }) : undefined}>
        {list?.map((s) => <SnippetRow key={s.id} snippet={s} />)}
        {list?.length === 0 && <p className="py-3 text-sm text-muted-foreground" data-testid="snippets-empty">{t("snippets.empty", { keys: snippetKeys() })}</p>}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-snippet-new" onClick={() => openSnippetEditor(newSnippetId(), { fresh: true })}>
            <Plus /> {t("snippets.new")}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
