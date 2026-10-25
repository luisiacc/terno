import { L, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { showText } from "./lifecycle";

afterEach(() => setLocale("en", en));

describe("showText (worker text on the page)", () => {
  it("a descriptor from the worker shows in the page's language, at render time", () => {
    const progress = L("web.worker.seedingDemo");
    const failed = L("web.worker.migrationFailed", { error: "QuotaExceededError" });
    // structured clone, as postMessage delivers it
    const received = structuredClone(failed);
    expect(showText(progress)).toBe("Creating the demo mailbox…");
    expect(showText(received)).toBe("Couldn’t move your mail from Única to Terno (QuotaExceededError). Nothing was deleted: reload to try again.");
    setLocale("es", es);
    expect(showText(progress)).toBe("Creando el buzón de demostración…");
    expect(showText(received)).toBe("No se pudo pasar tu correo de Única a Terno (QuotaExceededError). No se ha borrado nada: recarga para volver a intentarlo.");
  });

  it("a raw error stays as it came; an unknown key shows the message it carried", () => {
    setLocale("es", es);
    expect(showText("database disk image is malformed")).toBe("database disk image is malformed");
    expect(showText({ key: "web.gone", message: "From a newer build" })).toBe("From a newer build");
  });
});
