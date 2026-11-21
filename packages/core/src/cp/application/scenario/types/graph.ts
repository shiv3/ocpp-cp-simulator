import type { Node, Edge } from "@xyflow/react";
import type { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { EVSettings } from "../../../domain/connector/EVSettings";
import type { ScenarioNodeData, ScenarioExecutionMode } from "./nodeData";
import type { AssertionSpec, CsmsExpectations } from "./assertions";

/**
 * Scenario node with typed data
 */
export type ScenarioNode = Node<ScenarioNodeData>;

/**
 * The bounds of a loop edge (schema 1.10). All optional; the first one that is
 * satisfied at the end of a round exits the loop, none at all loops forever.
 */
export interface LoopBounds {
  /** Exit after this many rounds (a round is one pass of the source node;
   *  0 behaves like 1: the check runs after the first pass). */
  times?: number;
  /** Exit at the first check at or after this many seconds of the station
   *  clock since the loop was entered. A round that crosses it completes. */
  forSeconds?: number;
  /** Exit when `value` (a `$from` reference or a constant, as `switch.value`)
   *  matches one of `cases` (JSON constants or `{ "$match": … }`, as
   *  `switch.cases`). */
  until?: { value: unknown; cases: unknown[] };
}

/**
 * A scenario edge. `kind: "loop"` (schema 1.10) marks a loop edge: followed
 * out of its source after a round while its `loop` bounds are not satisfied,
 * and never as an ordinary next step. Any other edge is ordinary.
 */
export type ScenarioEdge = Edge & {
  kind?: "loop";
  loop?: LoopBounds;
};

/**
 * Scenario trigger configuration
 */
export interface ScenarioTrigger {
  type: "manual" | "statusChange";
  conditions?: {
    fromStatus?: OCPPStatus; // Optional: trigger only from specific status
    toStatus?: OCPPStatus; // Optional: trigger only to specific status
  };
}

/**
 * Scenario file schema version (issue #214), mirroring the `"major.minor"`
 * string convention and versioning rules of the Open OCPP Trace format's
 * `SCHEMA_VERSION` (`@open-ocpp-trace/core`, #886): additive
 * optional fields bump the minor version, consumers MUST ignore unknown
 * fields, and a semantic change to an existing field is a new major version.
 * See `packages/core/schema/scenario.schema.json` (Draft 2020-12) and
 * `docs/concepts/scenario-format.md`.
 */
export const SCENARIO_SCHEMA_VERSION = "1.13";

/** Where a recorded scenario came from (schema 1.6, #654 step 2). */
export interface ScenarioRecordedFrom {
  /** The id of the behavior that ran, e.g. `default.firmware`. */
  behaviorId: string;
  /** The build that ran it: git commit when known, else the version label. */
  commit: string;
  /** The seed of the run: the same seed records the same scenario. */
  seed: string | number;
  /** The simulator version that recorded it. */
  version: string;
}

/**
 * Scenario definition
 */
export interface ScenarioDefinition {
  /** Scenario schema version, e.g. {@link SCENARIO_SCHEMA_VERSION}. Optional:
   *  absent on files exported before issue #214 (they remain valid — schema
   *  conformance is advisory, never a hard gate). */
  schemaVersion?: string;
  id: string;
  /**
   * The built-in template this scenario was instantiated from, when it was.
   * Set by `templateFromJson`'s `createScenario`; absent on hand-authored
   * scenarios and on instances persisted by builds before this field existed.
   *
   * Informational on the daemon since #338: its template instances have the
   * stable id `<templateId>-c<connector>`, so "the same template on the same
   * connector" is the same key and a reload replaces it. Browser instances
   * still embed `Date.now()` in their id.
   */
  templateId?: string;
  /**
   * The web console's Library scenario this per-connector copy came from
   * (schema v1.4). Set when a connector is assigned a library scenario, so
   * the Library can tell which connectors use it and re-push an edit to
   * them. Absent on library entries themselves and on scenarios loaded by
   * hand (CLI, MCP, a JSON import onto a connector).
   */
  libraryId?: string;
  /**
   * Set on a scenario made by recording a behavior run (schema 1.6, #654
   * step 2), so it is never mistaken for the default behavior it came from.
   * Informational: the runtime ignores it.
   */
  recordedFrom?: ScenarioRecordedFrom;
  name: string;
  description?: string;
  targetType: "chargePoint" | "connector";
  targetId?: number; // Connector ID if targetType is "connector"
  nodes: ScenarioNode[];
  edges: ScenarioEdge[];
  createdAt: string;
  updatedAt: string;

  // Auto-execution settings
  trigger?: ScenarioTrigger; // Trigger configuration (default: manual)
  defaultExecutionMode?: ScenarioExecutionMode; // Default execution mode (default: oneshot)
  enabled?: boolean; // Enable/disable toggle (default: true)

  /**
   * Declarative EV settings applied to the target connector when this
   * scenario starts executing. A partial — only the listed fields are
   * written; the others keep their current value. Mid-scenario changes can
   * still be made via the `EV_SETTINGS_CHANGE` node.
   */
  evSettings?: Partial<EVSettings>;

  /**
   * #179 Phase 2b: declarative pass/fail assertions checked against the
   * captured OCPP wire transcript once the run ends. Optional — a scenario
   * with no assertions produces a SKIPPED verdict and runs exactly as
   * before (no behavior change).
   */
  assertions?: AssertionSpec[];

  /**
   * OCPP versions this scenario's wire shapes are written for, as `"1.6"`,
   * `"2.0.1"`, `"2.1"` (schema 1.12). Informational: a template loaded on a
   * charge point speaking another version still loads, and the daemon logs a warning. Absent: not declared.
   */
  ocppVersions?: string[];

  /**
   * What the scenario needs from the CSMS to take its intended path (schema
   * 1.12): the calls it waits for, with example payloads, and the answers it
   * needs. Informational: the runtime ignores it.
   */
  csmsExpectations?: CsmsExpectations;

  /**
   * Upper bound on the run, in seconds of the station's clock (schema 1.13).
   * When it has passed since the run started, the run ends normally (not
   * stopped): the flow is cut short, assertions are evaluated, and the
   * status and report carry `endedBy: "maxDuration"`. Absent or 0: no bound.
   */
  maxDurationSeconds?: number;

  /**
   * Promotes warning-severity assertion failures to run failures (strict
   * mode, #247). Default false; a per-run `strict` option overrides it.
   */
  strictCompatibility?: boolean;
}
