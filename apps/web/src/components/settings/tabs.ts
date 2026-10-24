import { AtSign, Bot, ListFilter, Palette, SlidersHorizontal, Sparkles, Tag } from "lucide-react";
import type { SettingsTab } from "~/state/app";

/** The settings sections, in sidebar order; the palette offers each as "Ajustes → <label>". */
export const SETTINGS_TABS: { value: SettingsTab; label: string; icon: typeof AtSign }[] = [
  { value: "general", label: "General", icon: SlidersHorizontal },
  { value: "appearance", label: "Apariencia", icon: Palette },
  { value: "accounts", label: "Cuentas", icon: AtSign },
  { value: "categories", label: "Categorías", icon: Tag },
  { value: "filters", label: "Filtros", icon: ListFilter },
  { value: "ai", label: "IA", icon: Sparkles },
  { value: "agents", label: "Agentes", icon: Bot },
];
