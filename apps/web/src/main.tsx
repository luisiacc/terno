// first: diagnostics catch what fails while the rest loads
import "./lib/diag";
import "@terno/ui/styles/globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AppBoundary } from "./components/diag/error-boundary";
import { boot } from "./lib/boot";

createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
void boot();
