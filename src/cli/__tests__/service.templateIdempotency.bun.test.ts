import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../cp/domain/persistence/Database";
import { testCpInit } from "./testCpInit";

/**
 * Template instances used to get a `${templateId}-${cpId}-c${connectorId}-
 * ${Date.now()}-${suffix}` id, were persisted, and were all rehydrated on the
 * next boot. So every pod restart and every template re-run added one more copy
 * per connector: the field report found three Essential CP Behavior entries
 * with weeks-old timestamps sitting in `list_scenarios`, and nothing ever
 * cleaned them up.
 *
 * Instantiating a template on a connector replaces any earlier instance of
 * THAT template on THAT connector — a different template on the same connector
 * is untouched, and so is the same template on another connector. Since #338
 * that is a property of the id, `<templateId>-c<connector>`, rather than of a
 * per-template cleanup pass (deleted): the daemon has one
 * prune, for startup-generated rows only.
 */
const TEMPLATE = "essential-cp-behavior";
const OTHER_TEMPLATE = "full-charging-cycle";
const CP_ID = "cp-template-idempotency";

function newService(database?: Database): CLIChargePointService {
  return new CLIChargePointService(
    testCpInit({
      cpId: CP_ID,
      connectors: 2,
    }),
    database ?? BunSqliteDatabase.open(":memory:"),
  );
}

function idsOn(service: CLIChargePointService, connectorId: number): string[] {
  return service.listScenarios(connectorId).map((s) => s.scenarioId);
}

describe("template instantiation is idempotent per (template, connector)", () => {
  it("replaces the previous instance under a stable id instead of accumulating", () => {
    const service = newService();

    const first = service.loadScenarioTemplate(TEMPLATE, 1);
    expect(first).toBe(`${TEMPLATE}-c1`);
    expect(idsOn(service, 1)).toEqual([first]);

    const second = service.loadScenarioTemplate(TEMPLATE, 1);
    const third = service.loadScenarioTemplate(TEMPLATE, 1);

    // Still exactly one, under the same key every time.
    expect(idsOn(service, 1)).toEqual([third]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("replaces the definition, not just the key", () => {
    const service = newService();
    service.loadScenarioTemplate(TEMPLATE, 1, undefined, { enabled: false });
    const id = service.loadScenarioTemplate(TEMPLATE, 1);
    expect(service.getScenario(1, id)?.enabled).not.toBe(false);
  });

  it("leaves a different template on the same connector alone", () => {
    const service = newService();
    const other = service.loadScenarioTemplate(OTHER_TEMPLATE, 1);
    service.loadScenarioTemplate(TEMPLATE, 1);
    const second = service.loadScenarioTemplate(TEMPLATE, 1);

    expect(idsOn(service, 1).sort()).toEqual([other, second].sort());
  });

  it("leaves the same template on another connector alone", () => {
    const service = newService();
    const onC1 = service.loadScenarioTemplate(TEMPLATE, 1);
    const onC2 = service.loadScenarioTemplate(TEMPLATE, 2);
    service.loadScenarioTemplate(TEMPLATE, 1);

    expect(onC2).not.toBe(onC1);
    expect(idsOn(service, 2)).toEqual([onC2]);
    expect(idsOn(service, 1)).toEqual([onC1]);
  });

  it("stamps templateId on the instance", () => {
    const service = newService();
    const id = service.loadScenarioTemplate(TEMPLATE, 1);
    expect(service.getScenario(1, id)?.templateId).toBe(TEMPLATE);
  });

  it("seedDefaultScenarios stays a single entry per connector across reseeds", () => {
    const service = newService();
    service.seedDefaultScenarios(TEMPLATE);
    service.seedDefaultScenarios(TEMPLATE);
    service.seedDefaultScenarios(TEMPLATE);

    expect(idsOn(service, 1)).toHaveLength(1);
    expect(idsOn(service, 2)).toHaveLength(1);
  });

  it("keeps a single row in the database, not just in memory", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const service = newService(db);
    service.loadScenarioTemplate(TEMPLATE, 1);
    const kept = service.loadScenarioTemplate(TEMPLATE, 1);

    // A fresh service over the same DB is exactly the restart path.
    const restarted = newService(db);
    expect(restarted.restoreScenariosFromDatabase()).toBe(1);
    expect(idsOn(restarted, 1)).toEqual([kept]);
  });

  it("keeps instances older builds left behind: they are no longer recognised, and a scenario is never deleted on a guess", () => {
    // The check the per-template cleanup pass made and #338 deliberately
    // drops. It matched the old clock-suffixed id format (rows without a
    // `templateId`) and any instance carrying this `templateId`, whatever its
    // id. Such a row cannot say whether a startup flag, the control plane or a
    // charge-point seed produced it, and the acceptance for #338 is that a
    // database written before provenance existed keeps every scenario. An
    // operator removes these once with `remove_scenario`.
    const db = BunSqliteDatabase.open(":memory:");
    const service = newService(db);
    const template = service.getScenario(
      1,
      service.loadScenarioTemplate(TEMPLATE, 1),
    )!;
    const legacy = [
      {
        ...template,
        id: `${TEMPLATE}-${CP_ID}-c1-1750000000000-abc123`,
        templateId: undefined,
      },
      { ...template, id: `${TEMPLATE}-${CP_ID}-c1-1760000000000-def456` },
    ];
    for (const definition of legacy) service.loadScenario(1, definition);

    const fresh = service.loadScenarioTemplate(TEMPLATE, 1);

    expect(idsOn(service, 1).sort()).toEqual(
      [fresh, ...legacy.map((d) => d.id)].sort(),
    );
  });

  it("does not mistake a different template whose id shares this one's prefix", () => {
    const service = newService();
    // `essential-cp-behavior-extended` starts with the template id under test;
    // a bare prefix match would wrongly delete it.
    const lookalike = `${TEMPLATE}-extended-c1`;
    const template = service.loadScenarioTemplate(TEMPLATE, 1);
    service.loadScenario(1, {
      ...service.getScenario(1, template)!,
      id: lookalike,
      templateId: `${TEMPLATE}-extended`,
    });

    service.loadScenarioTemplate(TEMPLATE, 1);

    expect(idsOn(service, 1)).toContain(lookalike);
    expect(idsOn(service, 1)).toHaveLength(2);
  });
});
