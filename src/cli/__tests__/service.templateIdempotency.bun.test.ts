import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../cp/domain/persistence/Database";

/**
 * Template instances get a `${templateId}-${cpId}-c${connectorId}-${Date.now()}
 * -${suffix}` id, are persisted, and are all rehydrated on the next boot. So
 * every pod restart and every template re-run added one more copy per
 * connector: the field report found three Essential CP Behavior entries with
 * weeks-old timestamps sitting in `list_scenarios`, and nothing ever cleaned
 * them up.
 *
 * Instantiating a template on a connector now replaces any earlier instance of
 * THAT template on THAT connector — a different template on the same connector
 * is untouched, and so is the same template on another connector.
 */
const TEMPLATE = "essential-cp-behavior";
const OTHER_TEMPLATE = "full-charging-cycle";
const CP_ID = "cp-template-idempotency";

function newService(database?: Database): CLIChargePointService {
  return new CLIChargePointService(
    {
      cpId: CP_ID,
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 2,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    database ?? BunSqliteDatabase.open(":memory:"),
  );
}

function idsOn(service: CLIChargePointService, connectorId: number): string[] {
  return service.listScenarios(connectorId).map((s) => s.scenarioId);
}

describe("template instantiation is idempotent per (template, connector)", () => {
  it("replaces the previous instance instead of accumulating", () => {
    const service = newService();

    const first = service.loadScenarioTemplate(TEMPLATE, 1);
    expect(idsOn(service, 1)).toEqual([first]);

    const second = service.loadScenarioTemplate(TEMPLATE, 1);
    const third = service.loadScenarioTemplate(TEMPLATE, 1);

    // Still exactly one, and it is the newest instance.
    expect(idsOn(service, 1)).toEqual([third]);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it("leaves a different template on the same connector alone", () => {
    const service = newService();
    const other = service.loadScenarioTemplate(OTHER_TEMPLATE, 1);
    const first = service.loadScenarioTemplate(TEMPLATE, 1);
    const second = service.loadScenarioTemplate(TEMPLATE, 1);

    const ids = idsOn(service, 1);
    expect(ids).toContain(other);
    expect(ids).toContain(second);
    expect(ids).not.toContain(first);
    expect(ids).toHaveLength(2);
  });

  it("leaves the same template on another connector alone", () => {
    const service = newService();
    const onC1 = service.loadScenarioTemplate(TEMPLATE, 1);
    const onC2 = service.loadScenarioTemplate(TEMPLATE, 2);
    service.loadScenarioTemplate(TEMPLATE, 1);

    expect(idsOn(service, 2)).toEqual([onC2]);
    expect(idsOn(service, 1)).not.toContain(onC1);
    expect(idsOn(service, 1)).toHaveLength(1);
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

  it("drops the replaced instance from the database, not just memory", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const service = newService(db);
    service.loadScenarioTemplate(TEMPLATE, 1);
    const kept = service.loadScenarioTemplate(TEMPLATE, 1);

    // A fresh service over the same DB is exactly the restart path.
    const restarted = newService(db);
    expect(restarted.restoreScenariosFromDatabase()).toBe(1);
    expect(idsOn(restarted, 1)).toEqual([kept]);
  });

  it("cleans up instances left behind by older builds, which have no templateId", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const service = newService(db);

    // Two accumulated rows in the pre-fix id format, no templateId field.
    for (const stamp of [1750000000000, 1760000000000]) {
      service.loadScenario(1, {
        ...service.getScenario(1, service.loadScenarioTemplate(TEMPLATE, 1))!,
        id: `${TEMPLATE}-${CP_ID}-c1-${stamp}-abc123`,
        templateId: undefined,
      });
    }
    expect(idsOn(service, 1).length).toBeGreaterThan(1);

    const fresh = service.loadScenarioTemplate(TEMPLATE, 1);
    expect(idsOn(service, 1)).toEqual([fresh]);
  });

  it("does not mistake a different template whose id shares this one's prefix", () => {
    const service = newService();
    // `essential-cp-behavior-extended` starts with the template id under test;
    // a bare prefix match would wrongly delete it.
    const lookalike = `${TEMPLATE}-extended-${CP_ID}-c1-1750000000000-abc123`;
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
