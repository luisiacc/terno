// Plan 118: the controls spec's markup, rendered in its own process (an in-process Vite build in another spec of the
// same worker can switch NODE_ENV between React's and react-dom/server's loads, and the two must match)
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { InputGroup, InputGroupInput } from "@terno/ui/components/input-group";
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
    ),
  ),
);
