import { FOLDER_NAME_MAX, FOLDERS_PER_ACCOUNT_MAX } from "@terno/core";
import { L, type Localized } from "@terno/i18n";
import type { ProviderFolder } from "@terno/store";
import { ProviderError } from "./types";

/**
 * Plan 107: what a folder change is checked against before anything is sent (the server's names, never the
 * sidebar's), for IMAP mailboxes, Gmail labels and the demo's list. Pure: each provider runs the commands.
 */

/** The longest mailbox path a LIST is read with (customFolders leaves longer ones out). */
const PATH_MAX = 1000;

const fail = (message: Localized) => new ProviderError(message, false);
export const nameTaken = (name: string) => fail(L("errors.folder.nameTaken", { name }));
export const notFound = () => fail(L("errors.folder.notFound"));
export const standardFolder = () => fail(L("errors.folder.standard"));
export const reservedName = (name: string) => fail(L("errors.folder.reservedName", { name }));

/** Names compare as servers and people do: case aside (Gmail refuses "work" beside "Work"; IMAP's INBOX is any case). */
export const sameName = (a: string, b: string) => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

/** A name typed for one level: no separator (it would make a level of its own), and within the server's length. */
export function checkName(name: string, separator: string | null): void {
  if (separator && name.includes(separator)) throw fail(L("errors.folder.nameSeparator", { separator }));
  if (name.length > FOLDER_NAME_MAX) throw fail(L("errors.folder.nameTooLong"));
}

/** A server's reason for a refusal, as it said it (bounded, one line): never anything of ours. */
export function serverReason(text: unknown): string {
  const reason = typeof text === "string" ? text.replace(/[\p{Cc}\s]+/gu, " ").trim() : "";
  return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}

export const refusedBy = (server: string, reason: string) => fail(L("errors.folder.refused", { server, reason }));

// ───────────────────────────── IMAP ─────────────────────────────

/** What folder changes read of a LIST entry. */
export interface ListedPath {
  path: string;
  delimiter?: string | null;
  flags: Set<string>;
}

const segments = (m: ListedPath) => (m.delimiter ? m.path.split(m.delimiter) : [m.path]);
const parentOf = (path: string, delimiter: string | null | undefined) => {
  const i = delimiter ? path.lastIndexOf(delimiter) : -1;
  return i > 0 ? path.slice(0, i) : "";
};
const exists = (m: ListedPath) => ![...m.flags].some((f) => f.toLowerCase() === "\\nonexistent");

/** Where imapflow sends a path (it adds the namespace's prefix to one without it): computed the same way, so the key is known. */
export function namespaced(path: string, prefix: string): string {
  return prefix && !path.startsWith(prefix) && path.toUpperCase() !== "INBOX" ? prefix + path : path;
}

/** The entry that names `key`, which must be one of the account's own folders (never INBOX or a role mailbox). */
function ownTarget(list: readonly ListedPath[], own: ReadonlySet<string>, key: string): ListedPath {
  const target = list.find((m) => m.path === key && exists(m));
  if (!target) throw notFound();
  if (!own.has(key)) throw standardFolder();
  return target;
}

/** A sibling (an entry under the same parent) already called `name`, case aside, on the server's own names. */
function siblingTaken(list: readonly ListedPath[], path: string, delimiter: string | null | undefined, name: string, except?: string): boolean {
  const parent = parentOf(path, delimiter);
  return list.some((m) => m.path !== except && exists(m) && parentOf(m.path, m.delimiter) === parent && sameName(segments(m).at(-1)!, name));
}

/** A folder and everything under it, as listed (groups included, what doesn't exist left out). */
function subtree(list: readonly ListedPath[], target: ListedPath): ListedPath[] {
  const below = target.delimiter ? target.path + target.delimiter : null;
  return list.filter((m) => exists(m) && (m.path === target.path || (below !== null && m.path.startsWith(below))));
}

const selectable = (m: ListedPath) => ![...m.flags].some((f) => f.toLowerCase() === "\\noselect");

/** Name heuristics for servers without SPECIAL-USE (es/en/de variants): what role discovery takes a mailbox for by its path. */
export const ROLE_NAME_HINTS = {
  sent: /^(inbox[./])?(sent|sent items|sent messages|sent mail|enviados|elementos enviados|gesendet)$/i,
  archive: /^(inbox[./])?(archive|archives|archivo|archivados|archiv)$/i,
  junk: /^(inbox[./])?(junk|spam|junk e-?mail|correo no deseado|bulk mail)$/i,
  trash: /^(inbox[./])?(trash|deleted items|deleted messages|papelera|elementos eliminados|bin|papierkorb)$/i,
  drafts: /^(inbox[./])?(drafts|borradores|entwürfe)$/i,
} as const;

/**
 * Codex code review round 9 #1: a path role discovery would take by its name for a role no mailbox holds by its flag
 * (\Archive, \Sent…; the flag is the role's name) would leave the own folders after the change, with no mapping:
 * the view, a favorite and the row would be lost. A role held by name only may move to the new path too (the first
 * match in the server's LIST order wins), so that is refused as well.
 */
function assertNoRoleName(list: readonly ListedPath[], paths: readonly string[], name: string): void {
  for (const [role, hint] of Object.entries(ROLE_NAME_HINTS)) {
    if (!paths.some((p) => hint.test(p))) continue;
    if (!list.some((m) => exists(m) && selectable(m) && [...m.flags].some((f) => f.toLowerCase() === "\\" + role))) throw reservedName(name);
  }
}

/**
 * A change that would take a role mailbox or INBOX with it (one nested under an own folder) is refused whole, and so
 * is one taking a mailbox the sidebar doesn't show as the account's own (Codex code review round 2 #1: a child marked
 * \Important, a server special, was deleted though neither listed nor counted in the confirmation).
 */
function assertOwnSubtree(paths: readonly ListedPath[], own: ReadonlySet<string>, roles: Readonly<Record<string, string | undefined>>): void {
  const rolePaths = new Set(Object.values(roles).filter((p): p is string => Boolean(p)));
  if (paths.some((m) => rolePaths.has(m.path) || m.path.toUpperCase() === "INBOX" || (selectable(m) && !own.has(m.path)))) throw standardFolder();
}

/** Plan 107: the path a new mailbox gets (under `parent`, or the top: the namespace's prefix), checked against a fresh LIST. */
export function planImapCreate(list: readonly ListedPath[], own: ReadonlySet<string>, parent: string | null, name: string, prefix: string): string {
  if (own.size >= FOLDERS_PER_ACCOUNT_MAX) throw fail(L("errors.folder.tooMany"));
  let path: string;
  let delimiter: string | null | undefined;
  if (parent !== null) {
    const p = ownTarget(list, own, parent);
    if (!p.delimiter) throw fail(L("errors.folder.noNesting"));
    delimiter = p.delimiter;
    path = parent + p.delimiter + name;
  } else {
    delimiter = (list.find((m) => m.path.toUpperCase() === "INBOX") ?? list.find((m) => m.delimiter))?.delimiter ?? null;
    path = namespaced(name, prefix);
  }
  checkName(name, delimiter ?? null);
  if (path.length > PATH_MAX) throw fail(L("errors.folder.nameTooLong"));
  if (siblingTaken(list, path, delimiter, name)) throw nameTaken(name);
  assertNoRoleName(list, [path], name);
  return path;
}

/** Plan 107: a mailbox's new path and where it and each one under it go (the server moves them with it). */
export function planImapRename(list: readonly ListedPath[], own: ReadonlySet<string>, roles: Readonly<Record<string, string | undefined>>, key: string, name: string, prefix: string): { path: string; moves: { from: string; to: string }[] } {
  const target = ownTarget(list, own, key);
  checkName(name, target.delimiter ?? null);
  const parent = parentOf(key, target.delimiter);
  const path = parent ? parent + target.delimiter + name : namespaced(name, prefix);
  const moved = subtree(list, target);
  assertOwnSubtree(moved, own, roles);
  if (moved.some((m) => path.length + m.path.length - key.length > PATH_MAX)) throw fail(L("errors.folder.nameTooLong"));
  if (siblingTaken(list, path, target.delimiter, name, key)) throw nameTaken(name);
  const moves = moved.map((m) => ({ from: m.path, to: path + m.path.slice(key.length) }));
  if (path !== key) assertNoRoleName(list, moves.map((m) => m.to), name);
  return { path, moves };
}

/** Plan 107: the mailboxes a delete takes, deepest first (some servers refuse a parent that still has children). */
export function planImapDelete(list: readonly ListedPath[], own: ReadonlySet<string>, roles: Readonly<Record<string, string | undefined>>, key: string): string[] {
  const target = ownTarget(list, own, key);
  const gone = subtree(list, target);
  assertOwnSubtree(gone, own, roles);
  return gone.map((m) => ({ path: m.path, depth: segments(m).length })).sort((a, b) => b.depth - a.depth).map((m) => m.path);
}

// ───────────────────────────── Gmail ─────────────────────────────

/** What folder changes read of a /labels entry. */
export interface LabelName {
  id: string;
  name: string;
  type?: string;
}

const userLabel = (l: LabelName) => l.type === "user" && l.id.startsWith("Label_");

/** The label `id`, which must be the user's own. */
function ownLabel(labels: readonly LabelName[], id: string): LabelName {
  const label = labels.find((l) => l.id === id);
  if (!label) throw notFound();
  if (!userLabel(label)) throw standardFolder();
  return label;
}

/** A full label name: within Gmail's length, and taken by no label at all (hidden and system ones included). */
function checkLabel(labels: readonly LabelName[], full: string, name: string, renaming: ReadonlySet<string> = new Set()): void {
  if (full.length > FOLDER_NAME_MAX) throw fail(L("errors.folder.nameTooLong"));
  if (labels.some((l) => !renaming.has(l.id) && sameName(l.name, full))) throw nameTaken(name);
}

/** Plan 107: a new label's full name ("Parent/Name"), checked against the raw catalog. */
export function planLabelCreate(labels: readonly LabelName[], parent: string | null, name: string): string {
  checkName(name, "/");
  if (labels.filter(userLabel).length >= FOLDERS_PER_ACCOUNT_MAX) throw fail(L("errors.folder.tooMany"));
  const full = parent === null ? name : `${ownLabel(labels, parent).name}/${name}`;
  checkLabel(labels, full, name);
  return full;
}

/** Plan 107: the label and each sublabel ("Old/…") with its new name, the label first; every new name checked before any request. */
export function planLabelRename(labels: readonly LabelName[], id: string, name: string): { id: string; from: string; to: string }[] {
  checkName(name, "/");
  const label = ownLabel(labels, id);
  const cut = label.name.lastIndexOf("/");
  const renamed = cut > 0 ? `${label.name.slice(0, cut)}/${name}` : name;
  const below = `${label.name}/`;
  const moves = [label, ...labels.filter((l) => l.name.startsWith(below))].map((l) => ({ id: l.id, from: l.name, to: renamed + l.name.slice(label.name.length) }));
  const renaming = new Set(moves.map((m) => m.id));
  for (const m of moves) checkLabel(labels, m.to, name, renaming);
  return moves;
}

/** Plan 107: the label and its sublabels, deepest first. */
export function planLabelDelete(labels: readonly LabelName[], id: string): LabelName[] {
  const label = ownLabel(labels, id);
  const below = `${label.name}/`;
  const depth = (l: LabelName) => l.name.split("/").length;
  return [label, ...labels.filter((l) => l.name.startsWith(below))].sort((a, b) => depth(b) - depth(a));
}

// ───────────────────────────── demo ─────────────────────────────

const under = (path: readonly string[], prefix: readonly string[]) => path.length >= prefix.length && prefix.every((p, i) => path[i] === p);

/**
 * Plan 107: the demo's change, computed from the account's list as stored (no server): Gmail-like accounts get a new
 * `Label_n` key and keep keys on a rename; IMAP-like ones key by path ("/"). `lastLabel`: the highest label number the
 * account ever gave (the provider keeps it), so a new label never takes a deleted one's id, whose mail the demo keeps
 * labelled (Codex code review round 19 #4: the highest deleted, the next one created took its id and its mail).
 */
export function demoFolderChange(folders: readonly ProviderFolder[], gmail: boolean, change: { create: { parent: string | null; name: string } } | { rename: { key: string; name: string } } | { delete: { key: string } }, lastLabel = 0): { folders: ProviderFolder[]; key?: string; renamed?: { from: string; to: string }[]; deleted?: string[] } {
  const find = (key: string) => {
    const f = folders.find((x) => x.key === key);
    if (!f) throw notFound();
    return f;
  };
  const taken = (parent: readonly string[], name: string, except?: string) =>
    folders.some((f) => f.key !== except && f.path.length === parent.length + 1 && under(f.path, parent) && sameName(f.path.at(-1)!, name));
  if ("create" in change) {
    const { parent, name } = change.create;
    checkName(name, "/");
    const at = parent === null ? null : find(parent);
    const path = [...(at?.path ?? []), name];
    if (taken(at?.path ?? [], name)) throw nameTaken(name);
    const next = folders.reduce((n, f) => Math.max(n, Number(/^Label_(\d+)$/.exec(f.key)?.[1] ?? 0)), lastLabel) + 1;
    const key = gmail ? `Label_${next}` : at ? `${at.key}/${name}` : name;
    return { folders: [...folders, { key, path, selectable: true }], key };
  }
  if ("rename" in change) {
    const { key, name } = change.rename;
    checkName(name, "/");
    const target = find(key);
    const depth = target.path.length - 1;
    if (taken(target.path.slice(0, depth), name, key)) throw nameTaken(name);
    const newKey = gmail ? key : [...key.split("/").slice(0, -1), name].join("/");
    const renamed: { from: string; to: string }[] = [];
    const next = folders.map((f) => {
      if (!under(f.path, target.path)) return f;
      const to = gmail ? f.key : newKey + f.key.slice(key.length);
      renamed.push({ from: f.key, to });
      return { ...f, key: to, path: f.path.map((p, i) => (i === depth ? name : p)) };
    });
    return { folders: next, renamed };
  }
  const target = find(change.delete.key);
  const deleted = folders.filter((f) => under(f.path, target.path)).map((f) => f.key);
  return { folders: folders.filter((f) => !deleted.includes(f.key)), deleted };
}
