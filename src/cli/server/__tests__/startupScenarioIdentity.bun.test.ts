import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLIChargePointService } from "../../service";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import {
  legacyStartupInstanceIds,
  readStartupScenarioFile,
  runStartupScenario,
  startupClaimedScenarioIds,
  startupInstanceId,
} from "../startServer";

/**
 * A startup-generated scenario has a **stable identity** (#314).
 *
 * The generated id used to carry `Date.now()`, so a daemon could not recognise
 * its own previous output: with `--state-db`, a restart restored the previous
 * boot's instance and then loaded a second one under a fresh id. The stale
 * graph stayed loaded — unwatched, since a startup registration is
 * `persist: false` and leaves no source row — and could auto-start alongside
 * the new one, so one configured scenario produced two graphs' worth of OCPP
 * traffic after every restart.
 *
 * These tests are about the *ordering* the id has to survive: a definition is
 * installed on one boot and read back on the next, and the two are the same
 * logical thing only if something identifies them as such.
 */
function scenarioJson(id: string, delaySeconds: number): string {
  return JSON.stringify({
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "start-1",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "wait",
        type: "delay",
        position: { x: 0, y: 1 },
        data: { label: "Wait", delaySeconds },
      },
      {
        id: "end-1",
        type: "end",
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "wait" },
      { id: "e2", source: "wait", target: "end-1" },
    ],
  });
}

/**
 * A charge point whose boot gate is already open, so `runStartupScenario` does
 * not spend its 30s `waitForBootAccepted` budget. No CSMS is needed: nothing
 * here asserts anything about the wire.
 */
function newService(
  db: BunSqliteDatabase | null,
  connectors: number,
): CLIChargePointService {
  const svc = new CLIChargePointService(
    {
      cpId: "cp-identity",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    db ?? undefined,
  );
  for (let id = 1; id <= connectors; id += 1) {
    svc.updateConnectorStatus(id, OCPPStatus.Available);
  }
  return svc;
}

function templateOptions(
  file: string,
): Parameters<typeof runStartupScenario>[1] {
  return {
    scenario: null,
    scenarioTemplate: null,
    scenarioTemplateFile: file,
    scenarioConnector: "all",
  };
}

describe("startup scenario identity across a restart (#314)", () => {
  it("a restart replaces the previous boot's instance instead of adding one", async () => {
    // The finding. Boot 1 loads and persists; boot 2 restores that row and
    // then runs the same flag. With a clock-based id the two are different
    // keys and the connector ends up holding both graphs; with a stable id
    // they are the same key and `loadScenario` replaces.
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-identity-"));
    const file = join(tmpDir, "template.json");
    writeFileSync(file, scenarioJson("startup-template", 11));
    const db = BunSqliteDatabase.open(":memory:");

    let first: CLIChargePointService | null = null;
    let second: CLIChargePointService | null = null;
    try {
      first = newService(db, 2);
      await runStartupScenario(first, templateOptions(file), 2, null, null);
      expect(first.listScenarios(1).map((s) => s.scenarioId)).toEqual([
        "startup-template-c1",
      ]);
      expect(first.listScenarios(2).map((s) => s.scenarioId)).toEqual([
        "startup-template-c2",
      ]);
      first.cleanup(false);

      // The restart. A fresh service over the same state DB rehydrates what
      // boot 1 stored, exactly as `restoreFromDatabase` does at boot.
      second = newService(db, 2);
      expect(second.restoreScenariosFromDatabase()).toBe(2);
      expect(second.listScenarios(1).map((s) => s.scenarioId)).toEqual([
        "startup-template-c1",
      ]);

      await runStartupScenario(second, templateOptions(file), 2, null, null);

      // One graph per connector, not two. This is the assertion the whole
      // change is for: with `Date.now()` in the id the restored instance is
      // still here beside a freshly-minted one.
      expect(second.listScenarios(1).map((s) => s.scenarioId)).toEqual([
        "startup-template-c1",
      ]);
      expect(second.listScenarios(2).map((s) => s.scenarioId)).toEqual([
        "startup-template-c2",
      ]);
    } finally {
      first?.cleanup(true);
      second?.cleanup(true);
      // Let the connector-runtime writes queued by cleanup drain before the
      // handle goes away, or they log "Cannot use a closed database" at a
      // point where nothing is wrong.
      await new Promise((resolve) => setTimeout(resolve, 50));
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops an instance a previous build generated with a clock-based id", async () => {
    // The upgrade path. Builds through 0f6f951 minted
    // `<base>-c<connector>-<epoch ms>`, so a state DB written by one carries a
    // row this boot's stable id can never match — left alone it stays loaded
    // forever, unwatched, and auto-starts beside the configured graph.
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-identity-legacy-"));
    const file = join(tmpDir, "template.json");
    writeFileSync(file, scenarioJson("startup-template", 11));

    const svc = newService(null, 1);
    try {
      svc.loadScenario(
        1,
        JSON.parse(
          scenarioJson("startup-template-c1-1757200000000", 99),
        ) as ScenarioDefinition,
        { autoStart: false },
      );
      expect(svc.listScenarios(1)).toHaveLength(1);

      await runStartupScenario(svc, templateOptions(file), 1, null, null);

      expect(svc.listScenarios(1).map((s) => s.scenarioId)).toEqual([
        "startup-template-c1",
      ]);
    } finally {
      svc.cleanup(true);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("leaves a scenario that only looks generated alone", () => {
    // The objection to pruning as a strategy, answered by making the pattern
    // exact: an operator's own `<base>-c1` and a same-prefix scenario with a
    // non-epoch suffix are not this code's output and are not touched.
    expect(
      legacyStartupInstanceIds(
        [
          "startup-template-c1",
          "startup-template-c1-manual",
          "startup-template-c1-42",
          "startup-template-c2-1757200000000",
          "other-c1-1757200000000",
          "startup-template-c1-1757200000000",
        ],
        "startup-template",
        1,
      ),
    ).toEqual(["startup-template-c1-1757200000000"]);

    // The base id is matched literally, not as a pattern: a scenario file may
    // name itself anything, and `a.b` must not match `axb`.
    expect(
      legacyStartupInstanceIds(["axb-c1-1757200000000"], "a.b", 1),
    ).toEqual([]);
    expect(
      legacyStartupInstanceIds(["a.b-c1-1757200000000"], "a.b", 1),
    ).toEqual(["a.b-c1-1757200000000"]);
  });

  it("claims the id it will load, from the bytes it will load", async () => {
    // The ordering half of #314's second finding, now applied to a *read*: the
    // claim used to come from its own read of the file, taken minutes before
    // the load's read across the restored fleet's connect. An edit in that
    // window made the prediction describe a file that was no longer the one
    // being loaded — the first restore pass held a row back under the old id
    // while the bootstrap loaded and deleted a different one.
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-identity-read-"));
    const file = join(tmpDir, "template.json");
    writeFileSync(file, scenarioJson("before-edit", 11));

    const svc = newService(null, 2);
    try {
      const opt = templateOptions(file);
      const source = readStartupScenarioFile(opt);
      const claimed = [...startupClaimedScenarioIds(opt, 2, source)];
      expect(claimed).toEqual(["before-edit-c1", "before-edit-c2"]);

      // The window: the operator saves a different scenario id while the fleet
      // is still connecting.
      writeFileSync(file, scenarioJson("after-edit", 22));

      await runStartupScenario(svc, opt, 2, null, null, source);

      // The load used the same bytes the claim was computed from, so the two
      // still agree. A second read here would load `after-edit-c1`, which the
      // claim never named and the restore pass never held back.
      expect([
        ...svc.listScenarios(1).map((s) => s.scenarioId),
        ...svc.listScenarios(2).map((s) => s.scenarioId),
      ]).toEqual(claimed);
    } finally {
      svc.cleanup(true);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("mints the same id for the same file and connector", () => {
    // The property everything above rests on, stated on its own: nothing in
    // this id comes from the clock.
    expect(startupInstanceId("demo", 1)).toBe(startupInstanceId("demo", 1));
    expect(startupInstanceId("demo", 1)).not.toBe(startupInstanceId("demo", 2));
  });
});
