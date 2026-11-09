import "i18next";
import type { enResources } from "./resources";

// Type-safe keys: English is the source of truth, so `t("no.such.key")` fails
// `tsc`. Keys are flat dotted strings (`keySeparator: false`), with the
// namespace implied by the file they live in (no `ns:` prefix).
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    fallbackNS: [
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
      "fleets",
    ];
    keySeparator: false;
    nsSeparator: false;
    resources: typeof enResources;
  }
}
