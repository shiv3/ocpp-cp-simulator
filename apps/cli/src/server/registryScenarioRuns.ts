import * as fs from "fs";
import { isScenarioDefinitionShape } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import type { ScenarioRunOptions } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type { CLIChargePointService } from "../service";

export class RegistryScenarioRuns {
  constructor(
    private readonly requireService: (id: string) => CLIChargePointService,
  ) {}

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const service = this.requireService(id);
    const connectorId = opts.connectorId ?? 1;
    const sourceText = fs.readFileSync(path, "utf-8");
    // `--watch` needs the exact bytes this call read as its reload baseline
    // (#314). Handed over, never returned: as a result field it reached
    // standalone JSON mode's stdout, because only the socket.io dispatcher
    // knew to strip it.
    opts.onSourceText?.(sourceText);
    const parsed: unknown = JSON.parse(sourceText);
    if (!isScenarioDefinitionShape(parsed)) {
      throw new Error(`file does not contain a scenario definition: ${path}`);
    }
    // Issue #214: advisory (warning-only) schema check — never blocks loading.
    const schemaResult = validateScenarioSchema(parsed);
    if (!schemaResult.valid) {
      console.warn(
        `[RegistryChargePointService] "${path}" does not match packages/core/schema/scenario.schema.json (loading anyway): ${schemaResult.errors.slice(0, 5).join("; ")}`,
      );
    }
    // The auto-start gate is suppressed here on purpose (#314). Left on, a file
    // with the usual connect-triggered start node is already running by the time
    // the load returns whenever the charge point is Available — the common case
    // — and the explicit start below then either threw "already running",
    // failing an RPC whose scenario was in fact loaded and running, or (once
    // that throw was skipped) silently dropped the caller's `strict` override
    // and reported success for a run this call never began. Neither is
    // distinguishable by the caller. Starting it here instead keeps the
    // requested options, and leaves "this id was already running before the
    // call" the honest error it has always been.
    // Refused *before* anything is installed, not after. `runScenario` has
    // always thrown on an id that is already running, but by then
    // `loadScenario` had replaced and persisted the definition — and the
    // dispatcher registers the new source file only once this method returns,
    // so a failed call left the new definition live behind the *old* file's
    // watch, and the next edit to that stale file quietly overwrote it. This
    // method performs a multi-step mutation with no transaction around it, so
    // the fix is to have no partial state to undo rather than to compensate for
    // one. The message is the one `runScenario` would have raised, so a caller
    // sees no change beyond the side effect disappearing (#314).
    if (service.isScenarioRunning(parsed.id)) {
      throw new Error(`Scenario ${parsed.id} is already running`);
    }
    const scenarioId = service.loadScenario(connectorId, parsed, {
      autoStart: false,
    });
    if (opts.strict === undefined) {
      service.runScenario(connectorId, scenarioId);
    } else {
      service.runScenario(connectorId, scenarioId, { strict: opts.strict });
    }
    return { scenarioId };
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const service = this.requireService(id);
    const connectorId = opts.connectorId ?? 1;
    // Same shape as runScenarioFile above (#318): the auto-start gate is kept
    // out of the way of the load, and the explicit start below is the one run
    // this call makes, with the caller's options. Left on, a connect-triggered
    // template — every cert16-* template is one — was already running by the
    // time the load returned whenever the charge point was Available, and the
    // start then threw "already running" for an RPC whose scenario was in fact
    // loaded and running. `once` (#352) additionally loads the instance
    // disabled, so the walker never re-arms it on a later reconnect.
    const scenarioId = service.loadScenarioTemplate(
      templateId,
      connectorId,
      opts.evSettings,
      { autoStart: false, ...(opts.once ? { enabled: false } : {}) },
    );
    if (opts.strict === undefined) {
      service.runScenario(connectorId, scenarioId);
    } else {
      service.runScenario(connectorId, scenarioId, { strict: opts.strict });
    }
    return { scenarioId };
  }
}
