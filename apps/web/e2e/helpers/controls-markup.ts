// Plans 118 and 120: the controls spec's markup, rendered in its own process (an in-process Vite build in another spec of the
// same worker can switch NODE_ENV between React's and react-dom/server's loads, and the two must match)
import { Avatar, AvatarFallback } from "@terno/ui/components/avatar";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { InputGroup, InputGroupInput } from "@terno/ui/components/input-group";
import { Separator } from "@terno/ui/components/separator";
import { Tabs, TabsList, TabsTrigger } from "@terno/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.stdout.write(
  renderToStaticMarkup(
    h(
      "div",
      { id: "controls-probe", style: { position: "fixed", inset: "40px auto auto 40px", zIndex: 9999, display: "grid", gap: 8, width: 240, padding: 8 }, className: "bg-background" },
      h(Button, { variant: "outline", "aria-invalid": true, "data-testid": "invalid-outline" }, "Invalid"),
      h(Button, { "data-testid": "primary" }, "Send"),
      h(Input, { disabled: true, "data-testid": "disabled-input", defaultValue: "180" }),
      h(InputGroup, { "data-testid": "group" }, h(InputGroupInput, { "data-testid": "group-input", placeholder: "Search" })),
      h("i", { "data-testid": "probe-destructive", className: "border border-destructive dark:border-destructive/50" }),
      h("i", { "data-testid": "probe-ring", className: "border border-ring" }),
      h("i", { "data-testid": "probe-disabled", className: "bg-input/50" }),
      h("i", { "data-testid": "probe-primary-hover", className: "bg-primary-hover" }),
      h("i", { "data-testid": "probe-primary", className: "bg-primary" }),
      h("i", { "data-testid": "probe-muted", className: "bg-muted" }),
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
      h("i", { "data-testid": "probe-hairline", className: "block h-(--hairline-w) bg-hairline" }),
    ),
  ),
);
