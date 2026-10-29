// Runs under `bun test`: the daemon's state DB is `bun:sqlite`.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLIChargePointService } from "../../service";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { SqliteScenarioRepository } from "../../../cp/domain/persistence/SqliteScenarioRepository";
import { runMigrations } from "../../../cp/domain/persistence/schema";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import type { ChargePointInitOptions } from "../../types";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import {
  installStartupScenario,
  pruneStaleStartupScenarios,
  readStartupScenarioFile,
  startServer,
  startupClaimedInstances,
  type RunningServer,
} from "../startServer";

/**
 * A startup-generated scenario records **what generated it** (#338).
 *
 * #314 gave a startup instance a stable id, so a restart replaces the previous
 * boot's copy instead of adding one. That only covers the instance the boot is
 * about to create. A copy left by a configuration no longer in force — a
 * connector the flags stopped naming, a file whose own `id` changed, a flag
 * that is gone — was restored, unwatched, and could auto-start beside the
 * configured graph. Nothing in the row said a startup flag had produced it.
 *
 * The row now says so (`scenarios.startup_source`, NULL = user-authored), and
 * one rule acts on it: every startup-generated row on a charge point that the
 * boot's flags do not call for is removed before anything dials.
 */
const CP = "cp-338";

function scenarioJson(
  id: string,
  options: {
    readonly triggerOn?: "connect";
    readonly delaySeconds?: number;
  } = {},
): string {
  return JSON.stringify({
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    ...(options.triggerOn ? {} : { trigger: { type: "manual" } }),
    nodes: [
      {
        id: "start-1",
        type: "start",
        position: { x: 0, y: 0 },
        data: {
          label: "S",
          ...(options.triggerOn ? { triggerOn: options.triggerOn } : {}),
        },
      },
      {
        id: "wait",
        type: "delay",
        position: { x: 0, y: 1 },
        data: { label: "Wait", delaySeconds: options.delaySeconds ?? 60 },
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

type StartupOptions = Parameters<typeof installStartupScenario>[1];

const NO_FLAGS: StartupOptions = {
  scenario: null,
  scenarioTemplate: null,
  scenarioTemplateFile: null,
  scenarioConnector: "all",
};

function init(connectors: number, wsUrl = "ws://127.0.0.1:65534/never") {
  return {
    cpId: CP,
    wsUrl,
    connectors,
    vendor: "v",
    model: "m",
    basicAuth: null,
  };
}

/**
 * One daemon boot, in the order `startServer` runs it: restore the stored
 * scenarios, prune what the flags no longer call for, then install. The
 * connectors are Available so nothing waits on a CSMS.
 */
function boot(
  db: BunSqliteDatabase,
  opt: StartupOptions,
  connectors: number,
  wsUrl?: string,
): CLIChargePointService {
  const svc = new CLIChargePointService(init(connectors, wsUrl), db);
  for (let id = 1; id <= connectors; id += 1) {
    svc.updateConnectorStatus(id, OCPPStatus.Available);
  }
  svc.restoreScenariosFromDatabase();
  const source = readStartupScenarioFile(opt);
  pruneStaleStartupScenarios(
    svc,
    db,
    new Map([[CP, startupClaimedInstances(opt, connectors, source)]]),
  );
  installStartupScenario(svc, opt, connectors, null, db, source);
  return svc;
}

function rows(db: BunSqliteDatabase): Array<{
  connector_id: number;
  scenario_id: string;
  startup_source: string | null;
}> {
  return db.all(
    "SELECT connector_id, scenario_id, startup_source FROM scenarios " +
      "WHERE cp_id = ? ORDER BY connector_id, scenario_id",
    [CP],
  );
}

function idsOn(svc: CLIChargePointService, connectorId: number): string[] {
  return svc.listScenarios(connectorId).map((s) => s.scenarioId);
}

const cleanups: Array<() => void | Promise<void>> = [];

/** A schema v17 database holding `seeded`, migrated to the current schema. */
function v17Database(
  seeded: ReadonlyArray<
    readonly [
      number,
      string,
      { readonly triggerOn?: "connect"; readonly enabled?: false }?,
    ]
  >,
): BunSqliteDatabase {
  const db = memoryDb();
  db.exec("DROP TABLE scenarios");
  db.exec(
    "CREATE TABLE scenarios (" +
      "cp_id TEXT NOT NULL, connector_id INTEGER NOT NULL, " +
      "scenario_id TEXT NOT NULL, name TEXT NOT NULL, " +
      "enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, " +
      "definition TEXT NOT NULL, " +
      "PRIMARY KEY (cp_id, connector_id, scenario_id))",
  );
  db.run("UPDATE schema_meta SET value = '17' WHERE key = 'version'");
  for (const [connectorId, id, options] of seeded) {
    db.run(
      "INSERT INTO scenarios (cp_id, connector_id, scenario_id, name, " +
        "enabled, updated_at, definition) VALUES (?, ?, ?, ?, 1, ?, ?)",
      [
        CP,
        connectorId,
        id,
        id,
        "2026-10-01T00:00:00Z",
        JSON.stringify({
          ...(JSON.parse(scenarioJson(id, options)) as object),
          targetId: connectorId,
          ...(options?.enabled === false ? { enabled: false } : {}),
        }),
      ],
    );
  }
  runMigrations(db);
  return db;
}

/** Dial the mock CSMS and accept the boot: every connect-triggered scenario
 *  still loaded auto-starts now. */
async function acceptBoot(
  svc: CLIChargePointService,
  csms: ReturnType<typeof startMockCsms>,
): Promise<void> {
  await svc.connect();
  const bootCall = await csms.waitForCall("BootNotification");
  csms.replyCallResult(bootCall.messageId, {
    currentTime: new Date().toISOString(),
    interval: 300,
    status: "Accepted",
  });
  await new Promise((r) => setTimeout(r, 200));
}

function activeIds(svc: CLIChargePointService, connectorId: number): string[] {
  return svc
    .listScenarios(connectorId)
    .filter((s) => s.active)
    .map((s) => s.scenarioId);
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-338-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  cleanups.push(async () => {
    // Let the connector-runtime writes queued by cleanup drain first.
    await new Promise((r) => setTimeout(r, 50));
    db.close();
  });
  return db;
}

function track(svc: CLIChargePointService): CLIChargePointService {
  cleanups.push(() => svc.cleanup(true));
  return svc;
}

describe("startup scenarios record what generated them (#338)", () => {
  it("marks each row a flag installs with the flag and its source", () => {
    const dir = tmp();
    const file = join(dir, "fanout.json");
    writeFileSync(file, scenarioJson("fanout"));
    const db = memoryDb();

    track(boot(db, { ...NO_FLAGS, scenario: file }, 2));
    track(boot(db, { ...NO_FLAGS, scenarioTemplateFile: file }, 2)).cleanup(
      false,
    );

    expect(rows(db)).toEqual([
      {
        connector_id: 1,
        scenario_id: "fanout-c1",
        startup_source: `--scenario-template-file=${resolve(file)}`,
      },
      {
        connector_id: 2,
        scenario_id: "fanout-c2",
        startup_source: `--scenario-template-file=${resolve(file)}`,
      },
    ]);
  });

  it("marks a built-in template's instance with the template id", () => {
    const db = memoryDb();
    track(
      boot(db, { ...NO_FLAGS, scenarioTemplate: "essential-cp-behavior" }, 1),
    );

    expect(rows(db)).toEqual([
      {
        connector_id: 1,
        scenario_id: "essential-cp-behavior-c1",
        startup_source: "--scenario-template=essential-cp-behavior",
      },
    ]);
  });

  it("keeps the mark when the same row is saved again, and loses it with the row", async () => {
    // A `--watch` reload, a charge-point update re-attaching its scenarios and
    // any other re-save all go through `loadScenario` under the same id. The
    // mark belongs to the key, so none of them may drop it — or the first file
    // edit would turn a startup instance into a "user-authored" one that no
    // later boot ever removes.
    const dir = tmp();
    const file = join(dir, "fanout.json");
    writeFileSync(file, scenarioJson("fanout"));
    const db = memoryDb();
    const svc = track(boot(db, { ...NO_FLAGS, scenario: file }, 2));

    const reloaded = {
      ...svc.getScenario(1, "fanout-c1")!,
      name: "edited",
    } as ScenarioDefinition;
    svc.loadScenario(1, reloaded, { autoStart: false });
    expect(rows(db).map((r) => r.startup_source)).toEqual([
      `--scenario=${resolve(file)}`,
      `--scenario=${resolve(file)}`,
    ]);

    // Removing the scenario removes the row, mark included: an id loaded under
    // the same key later starts out user-authored.
    svc.removeScenario(2, "fanout-c2");
    svc.loadScenario(
      2,
      JSON.parse(scenarioJson("fanout-c2")) as ScenarioDefinition,
      { autoStart: false },
    );
    expect(rows(db).find((r) => r.connector_id === 2)?.startup_source).toBe(
      null,
    );

    // Replacing a connector's whole set (the console upload) is a user write:
    // whatever it stores is the operator's.
    await new SqliteScenarioRepository(db).replaceConnector(CP, 1, [reloaded]);
    expect(rows(db).find((r) => r.connector_id === 1)?.startup_source).toBe(
      null,
    );
  });
});

describe("one prune rule for startup scenarios (#338)", () => {
  it("narrowing --scenario-connector leaves nothing on the dropped connector, and nothing auto-starts there", async () => {
    // Acceptance 1. Boot 1 fans `--scenario` across c1 and c2; boot 2 adds
    // `--scenario-connector 1`. The c2 copy was restored, and boot 2 never
    // prepares an id for c2, so before #338 nothing replaced or removed it.
    const dir = tmp();
    const file = join(dir, "fanout.json");
    writeFileSync(file, scenarioJson("fanout", { triggerOn: "connect" }));
    const db = memoryDb();
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());

    const first = track(boot(db, { ...NO_FLAGS, scenario: file }, 2));
    expect(idsOn(first, 2)).toEqual(["fanout-c2"]);
    first.cleanup(false);

    const second = track(
      boot(
        db,
        { ...NO_FLAGS, scenario: file, scenarioConnector: "1" },
        2,
        csms.url,
      ),
    );
    cleanups.push(() => second.disconnect());

    expect(idsOn(second, 2)).toEqual([]);
    expect(rows(db).map((r) => [r.connector_id, r.scenario_id])).toEqual([
      // One connector the file already targets keeps its own id.
      [1, "fanout"],
    ]);

    // The boot gate opens: every connect-triggered scenario still loaded
    // auto-starts now. c1's does; c2 has nothing left to start.
    await second.connect();
    const bootCall = await csms.waitForCall("BootNotification");
    csms.replyCallResult(bootCall.messageId, {
      currentTime: new Date().toISOString(),
      interval: 300,
      status: "Accepted",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(second.listScenarios(1).map((s) => s.active)).toEqual([true]);
    expect(second.listScenarios(2)).toEqual([]);
    expect(second.isScenarioRunning("fanout-c2")).toBe(false);
  });

  it("a file whose own id changes from A to B leaves only B", () => {
    // Acceptance 2. The stable id is derived from the file's id, so boot 2
    // mints a different key and boot 1's instance used to survive under A.
    const dir = tmp();
    const file = join(dir, "scenario.json");
    const db = memoryDb();

    writeFileSync(file, scenarioJson("A"));
    track(boot(db, { ...NO_FLAGS, scenario: file }, 2)).cleanup(false);
    writeFileSync(file, scenarioJson("B"));
    const second = track(boot(db, { ...NO_FLAGS, scenario: file }, 2));

    expect([...idsOn(second, 1), ...idsOn(second, 2)]).toEqual([
      "B-c1",
      "B-c2",
    ]);
    expect(rows(db).map((r) => r.scenario_id)).toEqual(["B-c1", "B-c2"]);
  });

  it("a built-in template narrowed or switched leaves only what the flag now names", () => {
    // `--scenario-template` follows the same rule now that its instance id is
    // stable: there is no second, template-shaped prune.
    const db = memoryDb();
    track(
      boot(db, { ...NO_FLAGS, scenarioTemplate: "essential-cp-behavior" }, 2),
    ).cleanup(false);

    track(
      boot(
        db,
        {
          ...NO_FLAGS,
          scenarioTemplate: "full-charging-cycle",
          scenarioConnector: "1",
        },
        2,
      ),
    ).cleanup(false);

    expect(rows(db).map((r) => [r.connector_id, r.scenario_id])).toEqual([
      [1, "full-charging-cycle-c1"],
    ]);
  });

  it("a seeded default a startup flag loads over stays user-authored", () => {
    // A charge point's seed and a `--scenario-template` of the same template
    // are the same key. The flag replaces the definition but did not create
    // the row, so the row keeps its NULL provenance and a later boot without
    // the flag leaves it — the charge point keeps its default, as on main.
    const SEED = "essential-cp-behavior";
    const db = memoryDb();
    const first = track(boot(db, NO_FLAGS, 1));
    first.seedDefaultScenarios(SEED);
    first.cleanup(false);

    track(boot(db, { ...NO_FLAGS, scenarioTemplate: SEED }, 1)).cleanup(false);
    expect(rows(db)).toEqual([
      { connector_id: 1, scenario_id: `${SEED}-c1`, startup_source: null },
    ]);

    const later = track(boot(db, NO_FLAGS, 1));
    expect(idsOn(later, 1)).toEqual([`${SEED}-c1`]);
  });

  it("a user-authored scenario loaded by RPC survives every boot", () => {
    // Acceptance 3. NULL provenance is never touched by the rule — whatever
    // the flags do, including disappearing altogether.
    const dir = tmp();
    const file = join(dir, "scenario.json");
    writeFileSync(file, scenarioJson("A"));
    const db = memoryDb();

    const first = track(boot(db, { ...NO_FLAGS, scenario: file }, 2));
    // Loaded over the control plane on both connectors, one of them under an
    // id that merely looks generated.
    first.loadScenario(
      1,
      JSON.parse(scenarioJson("mine")) as ScenarioDefinition,
      { autoStart: false },
    );
    first.loadScenario(
      2,
      JSON.parse(scenarioJson("A-c2-manual")) as ScenarioDefinition,
      { autoStart: false },
    );
    first.cleanup(false);

    const boots: StartupOptions[] = [
      { ...NO_FLAGS, scenario: file, scenarioConnector: "1" },
      { ...NO_FLAGS, scenarioTemplate: "essential-cp-behavior" },
      { ...NO_FLAGS, scenarioTemplateFile: file },
      NO_FLAGS,
    ];
    for (const opt of boots) {
      const svc = track(boot(db, opt, 2));
      expect(idsOn(svc, 1)).toContain("mine");
      expect(idsOn(svc, 2)).toContain("A-c2-manual");
      svc.cleanup(false);
    }
    // The last boot had no flag at all: every startup-generated row went with
    // it, and only the operator's two scenarios are left.
    expect(rows(db).map((r) => r.scenario_id)).toEqual(["mine", "A-c2-manual"]);
  });

  it("a database written before the migration keeps every scenario no boot replaces", () => {
    // Acceptance 4. Nothing an operator wrote is lost: a v17 row is NULL, and
    // an older build's clock-suffixed instance is only removed once a boot
    // installs its stable successor — which a boot without flags never does.
    const db = v17Database([
      [1, "operator-scenario"],
      [2, "demo-c2"],
      [1, "demo-c1-1757200000000"],
      [2, `essential-cp-behavior-${CP}-c2-1760000000000-abc123`],
    ]);
    const svc = track(boot(db, NO_FLAGS, 2));

    const expected = [
      "demo-c1-1757200000000",
      "demo-c2",
      `essential-cp-behavior-${CP}-c2-1760000000000-abc123`,
      "operator-scenario",
    ];
    expect(
      rows(db)
        .map((r) => r.scenario_id)
        .sort(),
    ).toEqual(expected);
    expect([...idsOn(svc, 1), ...idsOn(svc, 2)].sort()).toEqual(expected);
  });

  it("upgrading replaces an older build's --scenario instances instead of running them beside the stable ones", async () => {
    // The duplicate-traffic symptom, on the upgrade path: a pre-#314 state DB
    // holds `<base>-c<n>-<epoch ms>` copies of the file this boot loads. They
    // go before the charge point dials; the operator's scenario stays.
    const dir = tmp();
    const file = join(dir, "scenario.json");
    writeFileSync(file, scenarioJson("demo", { triggerOn: "connect" }));
    const db = v17Database([
      [1, "demo-c1-1757200000000", { triggerOn: "connect" }],
      [2, "demo-c2-1757200000000", { triggerOn: "connect" }],
      // Disabled, so the connector's auto-start slot is the startup one's.
      [1, "operator-scenario", { enabled: false }],
    ]);
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());

    const svc = track(boot(db, { ...NO_FLAGS, scenario: file }, 2, csms.url));
    cleanups.push(() => svc.disconnect());
    expect(rows(db).map((r) => [r.scenario_id, r.startup_source])).toEqual([
      ["demo-c1", `--scenario=${resolve(file)}`],
      ["operator-scenario", null],
      ["demo-c2", `--scenario=${resolve(file)}`],
    ]);

    await acceptBoot(svc, csms);
    expect(activeIds(svc, 1)).toEqual(["demo-c1"]);
    expect(activeIds(svc, 2)).toEqual(["demo-c2"]);
  });

  it("upgrading replaces an older build's --scenario-template instance, and only on the connector the flag names", () => {
    const db = v17Database([
      [1, `essential-cp-behavior-${CP}-c1-1760000000000-abc123`],
      [2, `essential-cp-behavior-${CP}-c2-1760000000001-def456`],
      [2, `full-charging-cycle-${CP}-c2-1760000000002-ghi789`],
      [1, "operator-scenario"],
    ]);
    track(
      boot(
        db,
        {
          ...NO_FLAGS,
          scenarioTemplate: "essential-cp-behavior",
          scenarioConnector: "1",
        },
        2,
      ),
    );

    expect(rows(db).map((r) => [r.connector_id, r.scenario_id])).toEqual([
      [1, "essential-cp-behavior-c1"],
      [1, "operator-scenario"],
      // c2 is not configured by this boot, so nothing replaces these.
      [2, `essential-cp-behavior-${CP}-c2-1760000000001-def456`],
      [2, `full-charging-cycle-${CP}-c2-1760000000002-ghi789`],
    ]);
  });

  it("leaves the previous boot's instances alone when the flag's file cannot be read", () => {
    // The boot cannot tell what its configuration calls for, so it removes
    // nothing on the charge points that configuration targets: an unreadable
    // file must not wipe the scenario it configured last time.
    const dir = tmp();
    const file = join(dir, "scenario.json");
    writeFileSync(file, scenarioJson("A"));
    const db = memoryDb();
    track(boot(db, { ...NO_FLAGS, scenario: file }, 2)).cleanup(false);

    writeFileSync(file, "{ not json");
    const svc = track(boot(db, { ...NO_FLAGS, scenario: file }, 2));

    expect([...idsOn(svc, 1), ...idsOn(svc, 2)]).toEqual(["A-c1", "A-c2"]);
  });

  it("claims exactly the instances the load installs, in every single-flag mode", () => {
    // The prune keeps what the flags call for, computed before anything
    // installs. That is only safe if the claim and the load agree.
    const dir = tmp();
    const file = join(dir, "scenario.json");
    writeFileSync(file, scenarioJson("targeted"));
    const modes: Array<[StartupOptions, number]> = [
      [{ ...NO_FLAGS, scenario: file }, 1],
      [{ ...NO_FLAGS, scenario: file }, 2],
      [{ ...NO_FLAGS, scenario: file, scenarioConnector: "2" }, 2],
      [{ ...NO_FLAGS, scenarioTemplateFile: file }, 2],
      [{ ...NO_FLAGS, scenarioTemplate: "essential-cp-behavior" }, 2],
      [NO_FLAGS, 2],
    ];
    for (const [opt, connectors] of modes) {
      const svc = new CLIChargePointService(init(connectors));
      try {
        const source = readStartupScenarioFile(opt);
        expect(startupClaimedInstances(opt, connectors, source)).toEqual(
          installStartupScenario(svc, opt, connectors, null, null, source),
        );
      } finally {
        svc.cleanup(true);
      }
    }
    // Unknown is not empty: an unreadable file or an unknown template claims
    // `null`, which the prune reads as "remove nothing here".
    expect(
      startupClaimedInstances(
        { ...NO_FLAGS, scenario: join(dir, "missing.json") },
        1,
        readStartupScenarioFile({
          ...NO_FLAGS,
          scenario: join(dir, "missing.json"),
        }),
      ),
    ).toBeNull();
    expect(
      startupClaimedInstances(
        { ...NO_FLAGS, scenarioTemplate: "no-such-template" },
        1,
        null,
      ),
    ).toBeNull();
  });
});

describe("startServer prunes before anything dials (#338)", () => {
  const BASE_OPTIONS = {
    httpHost: "127.0.0.1",
    httpPort: 0,
    pidPath: null,
    soapPath: "/ocpp/soap",
    autoConnect: false,
    cors: { kind: "any" } as const,
    staticDir: null,
    webConsolePort: null,
    healthPath: "/v1/healthz",
    webConsoleBasicAuth: null,
    insecureTlsKeyPerms: false,
  };

  it("removes the dropped connector's copy on the bootstrap charge point and on one no longer in the fleet", async () => {
    const dir = tmp();
    const file = join(dir, "fanout.json");
    writeFileSync(file, scenarioJson("fanout"));
    const stateDb = join(dir, "state.sqlite");
    const fanOut = { ...NO_FLAGS, scenario: file };
    // CP1 talks to a CSMS that accepts its boot, so boot 2's boot-gate wait
    // returns at once; CP2 dials nowhere.
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());
    const fleetInit = (cpId: string): ChargePointInitOptions => ({
      ...init(2, cpId === "CP1" ? csms.url : undefined),
      cpId,
    });

    {
      // Boot 1: two charge points, the file fanned out across both
      // connectors of each, plus one scenario an operator loaded.
      const db = BunSqliteDatabase.open(stateDb);
      const registry = new CPRegistry(new EventBus(), db, {});
      for (const cpId of ["CP1", "CP2"]) {
        const svc = registry.create(fleetInit(cpId), { seedDefault: false });
        installStartupScenario(svc, fanOut, 2, null, db);
      }
      registry
        .get("CP1")!
        .loadScenario(
          2,
          JSON.parse(scenarioJson("mine")) as ScenarioDefinition,
          { autoStart: false },
        );
      registry.shutdownAll();
      await new Promise((r) => setTimeout(r, 50));
      db.close();
    }

    // Boot 2: only CP1 is bootstrapped, and only on connector 1.
    const accepted = csms
      .waitForCall("BootNotification", 15_000)
      .then((bootCall) =>
        csms.replyCallResult(bootCall.messageId, {
          currentTime: new Date().toISOString(),
          interval: 300,
          status: "Accepted",
        }),
      );
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      autoConnect: true,
      stateDb,
      bootstrap: fleetInit("CP1"),
      startupScenario: { ...fanOut, scenarioConnector: "1" },
    });
    await accepted;
    running.stop();
    await new Promise((r) => setTimeout(r, 50));

    const db = BunSqliteDatabase.open(stateDb);
    try {
      expect(
        db.all(
          "SELECT cp_id, connector_id, scenario_id FROM scenarios " +
            "ORDER BY cp_id, connector_id, scenario_id",
        ),
      ).toEqual([
        { cp_id: "CP1", connector_id: 1, scenario_id: "fanout" },
        { cp_id: "CP1", connector_id: 2, scenario_id: "mine" },
      ]);
    } finally {
      db.close();
    }
  }, 20_000);
});
