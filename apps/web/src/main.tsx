// first: diagnostics catch what fails while the rest loads
import "./lib/diag";
import "@terno/ui/styles/globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AppBoundary } from "./components/diag/error-boundary";
import { boot } from "./lib/boot";
import { initLocale, installLanguageFollower, LocaleRoot } from "./lib/i18n";
import { designById } from "@terno/ui/designs/index";
import { loadDesignFaces } from "./lib/design";
import { useApp } from "./state/app";
import { ModalHostProvider } from "@terno/ui/components/modal-host";
import { NativeReloadNotice } from "./components/diag/native-reload-notice";

// the first frame is in the language this window used last (English needs no wait; a failure leaves English),
// and in the design theme.js painted, with its faces (local files) given up to 150 ms so text doesn't swap under the user
void Promise.all([initLocale(), loadDesignFaces(designById(document.documentElement.dataset.design), 150)]).then(() => {
  installLanguageFollower((listener) => useApp.subscribe((s, prev) => s.settings?.language !== prev.settings?.language && listener(s.settings?.language)));
  createRoot(document.getElementById("root")!).render(
    <ModalHostProvider>
      <AppBoundary>
        <LocaleRoot>
          <App />
        </LocaleRoot>
      </AppBoundary>
      <LocaleRoot><NativeReloadNotice /></LocaleRoot>
    </ModalHostProvider>,
  );
  void boot();
});
