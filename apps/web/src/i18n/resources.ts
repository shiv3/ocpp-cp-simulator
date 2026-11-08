/**
 * English resources. English is the source language and the fallback, so it is
 * bundled with the app; every other language is loaded on demand (see
 * `index.ts`). One JSON file per namespace under `locales/<language>/`.
 */
import common from "./locales/en/common.json";
import settings from "./locales/en/settings.json";
import scenarioEditor from "./locales/en/scenarioEditor.json";
import stateTransition from "./locales/en/stateTransition.json";
import consoleShared from "./locales/en/consoleShared.json";
import cp from "./locales/en/cp.json";
import dashboard from "./locales/en/dashboard.json";
import scenarios from "./locales/en/scenarios.json";
import templates from "./locales/en/templates.json";
import scenarioRun from "./locales/en/scenarioRun.json";
import cpPanels from "./locales/en/cpPanels.json";
import scenarioNodes from "./locales/en/scenarioNodes.json";

/** Namespaces, in lookup order. `common` is the default one; the others are
 * fallback namespaces so `t("scenarios.count.step")` needs no `ns:` prefix. */
export const NAMESPACES = [
  "common",
  "settings",
  "scenarioEditor",
  "stateTransition",
  "consoleShared",
  "cp",
  "dashboard",
  "scenarios",
  "templates",
  "scenarioRun",
  "cpPanels",
  "scenarioNodes",
] as const;

export const enResources = {
  common,
  settings,
  scenarioEditor,
  stateTransition,
  consoleShared,
  cp,
  dashboard,
  scenarios,
  templates,
  scenarioRun,
  cpPanels,
  scenarioNodes,
} as const;
