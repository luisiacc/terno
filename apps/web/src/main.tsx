import "@terno/ui/styles/globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { boot } from "./lib/boot";

createRoot(document.getElementById("root")!).render(<App />);
void boot();
