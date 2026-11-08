import common from "./common";
import settings from "./settings";
import scenarioEditor from "./scenarioEditor";
import stateTransition from "./stateTransition";
import consoleShared from "./consoleShared";
import cp from "./cp";
import dashboard from "./dashboard";
import scenarios from "./scenarios";
import templates from "./templates";

const en = {
  ...common,
  ...settings,
  ...scenarioEditor,
  ...stateTransition,
  ...consoleShared,
  ...cp,
  ...dashboard,
  ...scenarios,
  ...templates,
} as const;
export default en;
