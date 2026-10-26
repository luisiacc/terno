import type { BuiltinThemeId, DesignId, ThemeMode } from "@terno/core";

/**
 * A design (plan 15): typography, shape, density and a closed set of
 * structural variants. Colors live in palettes (themes/registry.ts); a design
 * only names the pair "Style colors" uses. Nothing here is optional, so a new
 * design has to decide every value, and every variant value must be handled
 * by the components that switch on it (lib/design.ts `variant()`).
 */
export interface DesignDefinition {
  id: DesignId;
  /** the palettes "Style colors" means */
  palette: Record<ThemeMode, BuiltinThemeId>;
  /** may the macOS sidebar show the window's vibrancy (ANDed with the palette's own flag) */
  vibrancy: boolean;
  fonts: {
    /** the UI font stack */
    sans: string;
    /** titles: the list title, the greeting, the reader subject, section labels where a design wants them */
    display: string;
    /** font-feature-settings for the whole UI */
    features: string;
    /** the faces to have loaded before this design paints (CSS font shorthands; empty: system fonts) */
    faces: readonly string[];
  };
  /** the shared dense scale, as [size, line height] (rem): utilities like text-sm read these */
  text: Record<TextStep, readonly [string, string]>;
  /** the radius ladder (utilities rounded-sm … rounded-4xl) */
  radius: Record<RadiusStep, string>;
  tracking: { tight: string; display: string };
  /** where designs actually differ in type: components use `type-<role>` (and `type-<role>-strong` for the emphasized weight) */
  type: Record<TypeRole, TypeSpec>;
  icon: {
    /** lucide stroke width everywhere */
    stroke: number;
    /** the reader toolbar's */
    toolbar: number;
  };
  layout: {
    /** grid: the sidebar's width and the list column's min/max */
    sidebar: string;
    listMin: string;
    listMax: string;
    /** the narrowest the reader gets when the user widens the sidebar or the list (px; plan 21): its toolbar still fits */
    readerMin: number;
    /** the reader's column and its side padding */
    readerMax: string;
    readerPadX: string;
    /** the selection/hover shape of a list row and a sidebar item */
    rowRadius: string;
    navRadius: string;
    /** a sidebar item's height */
    navHeight: string;
  };
  /** list row heights in px: the virtualizer reads these */
  rows: Record<"comfortable" | "compact", number>;
  /** avatar sizes in px (0: none) */
  avatar: { row: number; rowCompact: number; message: number; collapsed: number; senderCard: number };
  surfaces: {
    /** the inline draft's surface */
    draft: "tint" | "outline" | "card";
    /** a category's review badge (inline-badge): plain text, or on the accent wash */
    reviewBadge: "plain" | "tinted";
    /** the inbox's unread count in the sidebar: quiet, or in the unread color */
    inboxCount: "muted" | "unread";
  };
  variants: DesignVariants;
}

export const TEXT_STEPS = ["2xs", "xs", "sm", "base", "md", "lg", "xl"] as const;
export type TextStep = (typeof TEXT_STEPS)[number];

export const RADIUS_STEPS = ["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
export type RadiusStep = (typeof RADIUS_STEPS)[number];

export const TYPE_ROLES = [
  "listTitle",
  "greeting",
  "listSubtitle",
  "sectionLabel",
  "nav",
  "rowFrom",
  "rowSubject",
  "rowSnippet",
  "readerSubject",
  "senderName",
  "body",
  "compose",
] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

export interface TypeSpec {
  family: "sans" | "display";
  /** rem */
  size: string;
  /** unitless or rem */
  leading: string;
  weight: number;
  /** the emphasized weight (unread, active) */
  strong: number;
  tracking: string;
  style: "normal" | "italic";
}

/** The structural variants (plan 15 §3.3). Adding a value is a compile error until every `variant()` map handles it. */
export interface DesignVariants {
  /** where "new message" lives */
  compose: "list-header" | "sidebar-outline" | "sidebar-pill";
  /** the list header's title area */
  listHeader: "title" | "display" | "greeting";
  /** search: always a field, or a button that opens one */
  search: "field" | "button";
  /** quick filters: the filter button's menu, or chips under the header */
  quickFilters: "menu" | "chips";
  /** the list row's layout */
  row: "classic" | "avatar" | "large-avatar";
  /** a category's pending suggestions: a sub-row, or a badge in the category's row */
  categoryReview: "sub-rows" | "inline-badge";
  /** the reader's header above the conversation */
  readerHeader: "classic" | "chips-display" | "sender-card";
  /** the reader toolbar's reply group */
  replyAction: "icons" | "pill";
}
