import * as fs from "fs";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ServerOptions } from "./startServer";

/**
 * Which startup scenario option this boot is running, as one value.
 *
 * The precedence question, asked in one place. Three functions used to derive
 * something from the same three flags and each spelled out its own rule:
 * {@link installStartupScenario} took `--scenario-template` first, then
 * `--scenario-template-file`, then `--scenario`; {@link readStartupScenarioFile}
 * read `scenarioTemplateFile ?? scenario`; {@link startupClaimedScenarioIds}
 * looked only at whether either file flag was set. Pass `--scenario-template`
 * *and* `--scenario` together and the third disagreed with the first: the load
 * installed the built-in template and claimed nothing, while the prediction
 * claimed the file's ids — so the first restore pass held rows back for
 * scenarios that were never going to be loaded, and they stayed unwatched until
 * the charge point dialled.
 *
 * The combination is now refused rather than ranked (see
 * {@link startupScenarioOptionConflict}), so there is no precedence left to
 * disagree about: at most one flag is set, and every caller reads the same
 * discriminated union to find out which. A rule spelled out once cannot drift;
 * spelled out three times it already had (#314).
 */
export type StartupScenarioMode =
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "templateFile"; readonly path: string }
  | { readonly kind: "file"; readonly path: string };

/** The startup scenario flags, in the order a conflict message names them. */
const STARTUP_SCENARIO_FLAGS = [
  ["scenarioTemplate", "--scenario-template"],
  ["scenarioTemplateFile", "--scenario-template-file"],
  ["scenario", "--scenario"],
] as const;

/**
 * The message for a startup that names more than one scenario option, or
 * `null` when at most one is set.
 *
 * **Refused, not ranked.** Every ranking is a silent answer to a question the
 * operator asked ambiguously, and the three derivations above ranked them
 * differently. Refusing is the smaller invariant: no doc, example, compose file
 * or test in this repository passes two of these flags, so nothing that works
 * today stops working, and a combination that would have quietly ignored a flag
 * now names the flags it cannot reconcile (#314).
 *
 * Returned rather than thrown so the CLI can refuse at parse time — see
 * `apps/cli/src/main.ts` — while {@link resolveStartupScenarioMode} throws for
 * programmatic callers that never went through it.
 */
export function startupScenarioOptionConflict(
  opt: ServerOptions["startupScenario"],
): string | null {
  if (!opt) return null;
  const given = STARTUP_SCENARIO_FLAGS.filter(([key]) => !!opt[key]).map(
    ([, flag]) => flag,
  );
  if (given.length < 2) return null;
  return `${given.join(", ")} cannot be combined - pass exactly one startup scenario option`;
}

/**
 * The one startup mode the flags name, or `null` when they name none.
 *
 * Throws on a conflicting combination. The daemon refuses it earlier and more
 * politely (the CLI at parse time, {@link startServer} before it opens the
 * database), so this throw is the backstop for a caller that built the options
 * object itself: silently picking one flag is the behaviour this function
 * exists to remove.
 */
export function resolveStartupScenarioMode(
  opt: ServerOptions["startupScenario"],
): StartupScenarioMode | null {
  const conflict = startupScenarioOptionConflict(opt);
  if (conflict) throw new Error(conflict);
  if (!opt) return null;
  if (opt.scenarioTemplate)
    return { kind: "template", templateId: opt.scenarioTemplate };
  if (opt.scenarioTemplateFile)
    return { kind: "templateFile", path: opt.scenarioTemplateFile };
  if (opt.scenario) return { kind: "file", path: opt.scenario };
  return null;
}

/**
 * The scenario file a startup flag names, read **once** for the whole boot.
 *
 * Both `--scenario` and `--scenario-template-file` used to be read twice: once
 * early, to work out which stored scenario ids the flags were about to claim,
 * and again per charge point inside the bootstrap loop, to load. Those are two
 * different points in time with the whole restored fleet's connect between
 * them — minutes against a slow CSMS — so an edit landing in the window made
 * the prediction describe a file that was no longer being loaded: the first
 * restore pass held back a row under the old id while the bootstrap loaded and
 * deleted a different one, and the second pass then reattached the held row and
 * reloaded the current file under an abandoned id. Two live copies out of one
 * flag (#314).
 *
 * One read settles it. The claim is derived from the same bytes that are
 * loaded, so the two cannot disagree — and an edit that lands mid-boot is not
 * lost either: `registerScenarioFile` reconciles the registration against disk
 * immediately, so `--watch` applies it the moment the watch goes on.
 *
 * `null` when no file flag is set, or when the file cannot be read or parsed —
 * `runStartupScenario` reports that properly a moment later, and claiming
 * nothing is the safe answer, since every row is then restored in the first
 * pass exactly as with no flag at all.
 */
export interface StartupScenarioFile {
  readonly path: string;
  /**
   * `null` when the file could not be read or parsed — `error` says why, and
   * carrying the failure rather than collapsing it to a bare `null` is what
   * keeps `runStartupScenario`'s diagnostic as specific as it was when it did
   * its own read.
   */
  readonly text: string | null;
  readonly definition: ScenarioDefinition | null;
  readonly error: unknown;
}

export function readStartupScenarioFile(
  opt: ServerOptions["startupScenario"],
): StartupScenarioFile | null {
  const mode = resolveStartupScenarioMode(opt);
  if (!mode || mode.kind === "template") return null;
  const filePath = mode.path;
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return {
      path: filePath,
      text,
      definition: JSON.parse(text) as ScenarioDefinition,
      error: null,
    };
  } catch (err) {
    return { path: filePath, text: null, definition: null, error: err };
  }
}
