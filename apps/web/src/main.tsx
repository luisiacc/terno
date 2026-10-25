// first: diagnostics catch what fails while the rest loads
import "./lib/diag";
import "@terno/ui/styles/globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AppBoundary } from "./components/diag/error-boundary";
import { boot } from "./lib/boot";
import { initLocale, installLanguageFollower, LocaleRoot } from "./lib/i18n";
import { useApp } from "./state/app";

// the first frame is in the language this window used last (English needs no wait; a failure leaves English)
void initLocale().then(() => {
  installLanguageFollower((listener) => useApp.subscribe((s, prev) => s.settings?.language !== prev.settings?.language && listener(s.settings?.language)));
  createRoot(document.getElementById("root")!).render(
    <AppBoundary>
      <LocaleRoot>
        <App />
      </LocaleRoot>
    </AppBoundary>,
  );
  void boot();
});
