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
    // The template texts (`templates.<id>.name` / `.description`, one pair per
    // built-in template) are looked up by an id only known at runtime
    // (`useTemplateText`), so no typed key is ever written for them. Left out of
    // the typed keys, they stay out of the way of the compiler: with them the
    // key union is big enough for `tsc` to give up on the unrelated `t` calls.
    resources: Omit<typeof enResources, "templates"> & {
      templates: Record<never, string>;
    };
  }
}
