import { create } from "zustand";

/**
 * Plan 89: which snippet Settings → Snippets is editing (null: the list).
 * Set from outside too (Save as snippet…, New snippet… in the palette).
 */
export interface SnippetEditorState {
  editing: string | null;
  /** a snippet that isn't saved yet (New snippet): created on its first change */
  fresh: boolean;
  /** the name selected when the editor opens (a snippet named for you, to rename) */
  selectName: boolean;
}

export const useSnippetEditor = create<SnippetEditorState>(() => ({ editing: null, fresh: false, selectName: false }));

export function openSnippetEditor(id: string, o: { fresh?: boolean; selectName?: boolean } = {}): void {
  useSnippetEditor.setState({ editing: id, fresh: o.fresh ?? false, selectName: o.selectName ?? false });
}

export function closeSnippetEditor(): void {
  useSnippetEditor.setState({ editing: null, fresh: false, selectName: false });
}
