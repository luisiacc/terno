// Plans 118 and 120: the controls spec's markup, rendered in its own process (an in-process Vite build in another spec of the
// same worker can switch NODE_ENV between React's and react-dom/server's loads, and the two must match)
import { Avatar, AvatarFallback } from "@terno/ui/components/avatar";
import { Announcement } from "@terno/ui/components/announcement";
import { Button } from "@terno/ui/components/button";
import { ButtonGroup, ButtonGroupItem } from "@terno/ui/components/button-group";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@terno/ui/components/accordion";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { ColorSwatch, ColorSwatches } from "@terno/ui/components/color-swatches";
import { DialogFooter } from "@terno/ui/components/dialog";
import { IconButton } from "@terno/ui/components/icon-button";
import { Input } from "@terno/ui/components/input";
import { InputGroup, InputGroupInput } from "@terno/ui/components/input-group";
import { Kbd } from "@terno/ui/components/kbd";
import { NumberField } from "@terno/ui/components/number-field";
import { Pagination } from "@terno/ui/components/pagination";
import { Progress } from "@terno/ui/components/progress";
import { Radio, RadioCard, RadioDot, RadioGroup } from "@terno/ui/components/radio-group";
import { SearchField } from "@terno/ui/components/search-field";
import { Separator } from "@terno/ui/components/separator";
import { Skeleton } from "@terno/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Archive, Sparkles } from "@terno/ui/icons";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.stdout.write(
  renderToStaticMarkup(
    h(
      "div",
      { id: "controls-probe", style: { position: "fixed", inset: "40px auto auto 40px", zIndex: 9999, display: "grid", gap: 8, width: 240, padding: 8 }, className: "bg-background" },
      h(Button, { variant: "outline", "aria-invalid": true, "data-testid": "invalid-outline" }, "Invalid"),
      h(Button, { "data-testid": "primary" }, "Send"),
      // plan 173: every kind of button, for its hover and press
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        h(Button, { "data-testid": "state-primary" }, "Save"),
        h(Button, { variant: "outline", "data-testid": "state-outline" }, "Cancel"),
        h(Button, { variant: "secondary", "data-testid": "state-secondary" }, "More"),
        h(Button, { variant: "ghost", "data-testid": "state-ghost" }, "Rules"),
        h(Button, { variant: "destructive", "data-testid": "state-danger" }, "Delete"),
        h(ButtonGroup, { "aria-label": "Group" }, h(ButtonGroupItem, { "data-testid": "state-group-item" }, "Reply"), h(ButtonGroupItem, null, "Forward")),
        h(Button, { "aria-disabled": true, "data-testid": "state-primary-unavailable" }, "Send"),
      ),
      h(Input, { disabled: true, "data-testid": "disabled-input", defaultValue: "180" }),
      h(InputGroup, { "data-testid": "group" }, h(InputGroupInput, { "data-testid": "group-input", placeholder: "Search" })),
      h("i", { "data-testid": "probe-destructive", className: "border border-destructive dark:border-destructive/50" }),
      h("i", { "data-testid": "probe-ring", className: "border border-ring" }),
      h("i", { "data-testid": "probe-primary-hover", className: "bg-primary-hover" }),
      h("i", { "data-testid": "probe-primary", className: "bg-primary" }),
      h("i", { "data-testid": "probe-muted", className: "bg-muted" }),
      // (no utility in the app uses bg-menu-highlight, so Tailwind has no class for it)
      h("i", { "data-testid": "probe-menu-highlight", style: { backgroundColor: "var(--menu-highlight)" } }),
      // plan 120: the segmented control, both kinds of tabs, an avatar and a divider; the tokens they should show
      h(ToggleGroup, { variant: "segmented", value: ["a"], "aria-label": "Segmented", "data-testid": "segmented" }, h(ToggleGroupItem, { value: "a", "data-testid": "segmented-on" }, "One"), h(ToggleGroupItem, { value: "b", "data-testid": "segmented-off" }, "Two")),
      h(Tabs, { defaultValue: "a" }, h(TabsList, { "data-testid": "tabs" }, h(TabsTrigger, { value: "a", "data-testid": "tab-on" }, "One"), h(TabsTrigger, { value: "b" }, "Two"))),
      h(Tabs, { defaultValue: "a" }, h(TabsList, { variant: "line" }, h(TabsTrigger, { value: "a", "data-testid": "line-tab-on" }, "One"), h(TabsTrigger, { value: "b" }, "Two"))),
      h(Avatar, { size: "lg", "data-testid": "avatar" }, h(AvatarFallback, null, "AB")),
      h(Separator, { "data-testid": "separator" }),
      h("i", { "data-testid": "probe-card", className: "bg-card" }),
      h("i", { "data-testid": "probe-field", className: "bg-field" }),
      h("i", { "data-testid": "probe-background", className: "bg-background" }),
      h("i", { "data-testid": "probe-primary-ink", className: "text-primary" }),
      h("i", { "data-testid": "probe-foreground", className: "text-foreground" }),
      h("i", { "data-testid": "probe-primary-ink-on", className: "text-primary-foreground" }),
      h("i", { "data-testid": "probe-hairline", className: "block h-(--hairline-w) bg-hairline" }),
      // plan 125: BoardUI's danger, unavailable fills, a busy button, the indeterminate checkbox, the skeleton, a key, the
      // dialog's footer (its resting look); the tokens they should show
      h(Button, { variant: "destructive", "data-testid": "danger" }, "Delete"),
      h(Button, { disabled: true, "data-testid": "primary-off" }, "Send"),
      h(Button, { variant: "destructive", disabled: true, "data-testid": "danger-off" }, "Delete"),
      h(Button, { variant: "outline", disabled: true, "data-testid": "outline-off" }, "Cancel"),
      h("div", { style: { display: "flex", gap: 8 } }, h(Button, { "data-testid": "idle" }, "Remove all"), h(Button, { loading: true, "data-testid": "busy" }, "Remove all")),
      h(InputGroup, { "data-testid": "disabled-group" }, h(InputGroupInput, { disabled: true, "data-testid": "disabled-group-input", defaultValue: "180" })),
      h("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, h(Checkbox, { indeterminate: true, "aria-label": "Some", "data-testid": "indeterminate" }), h(Checkbox, { defaultChecked: true, "aria-label": "All", "data-testid": "checked" }), h(Kbd, { "data-testid": "kbd" }, "⌘K")),
      h(Skeleton, { shape: "text", className: "w-10", "data-testid": "skeleton" }),
      h("div", { "data-testid": "dialog-footer-host", className: "rounded-2xl bg-popover p-6" }, h(DialogFooter, { "data-testid": "dialog-footer" }, h(Button, { variant: "outline" }, "Cancel"), h(Button, null, "Save"))),
      h("i", { "data-testid": "probe-danger", className: "bg-destructive" }),
      h("i", { "data-testid": "probe-danger-shade", className: "bg-destructive-shade" }),
      h("i", { "data-testid": "probe-danger-ink", className: "text-destructive-foreground" }),
      h("i", { "data-testid": "probe-muted-ink", className: "text-muted-foreground" }),
      h("i", { "data-testid": "probe-ink-tint", className: "bg-foreground/8" }),
      h("i", { "data-testid": "probe-popover", className: "bg-popover" }),
      // plan 125, phase 2a: the radio and its card, the swatches, the number field, the pager, the disclosures and the
      // progress bar at rest; the tokens they should show
      h(RadioGroup, { defaultValue: "a", "aria-label": "Radios", className: "flex-row" }, h(Radio, { value: "a", "data-testid": "radio-on" }, "One"), h(Radio, { value: "b", "data-testid": "radio-off" }, "Two")),
      h(RadioGroup, { defaultValue: "a", "aria-label": "Cards", className: "flex-row" }, h(RadioCard, { value: "a", "data-testid": "radio-card-on", className: "gap-2 p-2" }, "One", h(RadioDot)), h(RadioCard, { value: "b", "data-testid": "radio-card-off", className: "gap-2 p-2" }, "Two", h(RadioDot))),
      h(ColorSwatches, { defaultValue: "rose", "aria-label": "Color" }, h(ColorSwatch, { value: "rose", label: "Rose", color: "var(--cat-rose)", "data-testid": "swatch-on" }), h(ColorSwatch, { value: "lime", label: "Lime", color: "var(--cat-lime)", "data-testid": "swatch-off" })),
      h(NumberField, { "aria-label": "Days", defaultValue: 30, "data-testid": "number-input", className: "w-32" }),
      h(Pagination, { page: 0, pageSize: 25, total: 80, onPageChange: () => {} }),
      h(Collapsible, { defaultOpen: true }, h(CollapsibleTrigger, { "data-testid": "collapsible-open" }, "Open"), h(CollapsiblePanel, null, "Inside")),
      h(Accordion, null, h(AccordionItem, { value: 1 }, h(AccordionTrigger, { "data-testid": "accordion-closed" }, "Closed"), h(AccordionPanel, null, "Inside"))),
      h(Progress, { value: 40, label: "Work", valueLabel: "40%", "data-testid": "progress" }),
      h("i", { "data-testid": "probe-control-edge", className: "border border-control-edge" }),
      h("i", { "data-testid": "probe-control-edge-hover", className: "border border-control-edge-hover" }),
      h("i", { "data-testid": "probe-border", className: "border border-border" }),
      h("i", { "data-testid": "probe-primary-border", className: "border border-primary" }),
      h("i", { "data-testid": "probe-primary-ink-on-bg", className: "bg-primary-foreground" }),
      h("i", { "data-testid": "probe-cat-rose", className: "bg-cat-rose" }),
      // plan 125, phase 2b: the icon button, the chip, the search field, the announcement, the link button and the toast's
      // surface at rest; the tokens they should show
      h(ButtonGroup, { "aria-label": "Respond", "data-testid": "button-group" }, h(ButtonGroupItem, { "data-testid": "button-group-item" }, h(Archive), "Reply"), h(ButtonGroupItem, { iconOnly: true, "aria-label": "More", "data-testid": "button-group-icon" }, h(Archive))),
      h("div", { style: { display: "flex", gap: 8 } }, h(IconButton, { label: "Archive", shortcut: "e", "data-testid": "icon-ghost" }, h(Archive)), h(IconButton, { label: "Archive", variant: "secondary", size: "icon", "data-testid": "icon-secondary" }, h(Archive))),
      h("div", { style: { display: "flex", gap: 8 } }, h(Chip, { dot: h(CategoryDot, { color: "rose" }), onRemove: () => {}, removeLabel: "Remove Work", removeProps: { "data-testid": "chip-remove" }, "data-testid": "chip" }, "Work")),
      h(SearchField, { "aria-label": "Search", value: "ana", onValueChange: () => {}, "data-testid": "search-full", hint: h(Kbd, null, "/") }),
      h(SearchField, { "aria-label": "Search", value: "", onValueChange: () => {}, "data-testid": "search-empty", hint: h(Kbd, { "data-testid": "search-hint" }, "/") }),
      h(Announcement, { icon: h(Sparkles), title: "Title", titleProps: { "data-testid": "announcement-title" }, description: "Body", onClose: () => {}, closeProps: { "data-testid": "announcement-close" }, "data-testid": "announcement", className: "m-0" }),
      h(Button, { variant: "link", "data-testid": "link" }, "Try again"),
      h("div", { "data-testid": "snack-surface", className: "snack-surface rounded-xl p-2" }, "Archived"),
      h("i", { "data-testid": "probe-tint", className: "bg-tint" }),
      // plan 137: a button in a nested design draws that design's corners
      h("div", { "data-design": "luma" }, h(Button, { "data-testid": "nested-primary" }, "Send")),
    ),
  ),
);
