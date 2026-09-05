import { describe, it, expect } from "bun:test";
import type * as fsTypes from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { CLIChargePointService } from "../../service";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { FileReloadManager } from "../FileReloadManager";
import { FileWatcher, type WatchFactory } from "../FileWatcher";
import {
  restoredDialsToDefer,
  runStartupScenario,
  startupClaimedScenarioIds,
} from "../startServer";
import {
  listWatchedScenarioFiles,
  rememberWatchedScenarioFile,
} from "../watchedScenarioFiles";

/**
 * `--watch` over a `--scenario-template-file` fan-out (#314).
 *
 * The startup flags are the case the issue is actually about — a human editing
 * a scenario file by hand — and they are the one registration path that does
 * not go through the RPC layer, so it needs its own coverage. The fan-out
 * matters too: each connector gets its own instance, and a reload has to rerun
 * the same per-connector rewrite instead of collapsing every connector onto the
 * file's own `targetId`.
 */

/** A hand-driven `fs.watch`: the file is real, only the notification is not. */
class TestWatchBackend {
  private readonly listeners = new Map<
    string,
    Set<(eventType: string, filename: string | null) => void>
  >();

  readonly factory: WatchFactory = (directory, listener) => {
    let set = this.listeners.get(directory);
    if (!set) {
      set = new Set();
      this.listeners.set(directory, set);
    }
    set.add(listener);
    const handle = {
      on: () => handle,
      close: () => {
        set?.delete(listener);
      },
    };
    return handle as unknown as fsTypes.FSWatcher;
  };

  save(filePath: string, contents: string): void {
    writeFileSync(filePath, contents);
    for (const listener of [...(this.listeners.get(dirname(filePath)) ?? [])]) {
      listener("change", basename(filePath));
    }
  }
}

function template(delayMs: number): string {
  return JSON.stringify({
    id: "startup-template",
    name: "Startup template",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "wait",
        type: "delay",
        position: { x: 0, y: 0 },
        data: { label: "Wait", delaySeconds: delayMs },
      },
    ],
    edges: [],
  });
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The `delaySeconds` of the single node in the instance on this connector. */
function loadedDelay(
  svc: CLIChargePointService,
  connectorId: number,
): number | null {
  const scenarioId = svc.listScenarios(connectorId)[0]?.scenarioId;
  if (!scenarioId) return null;
  const node = svc.getScenario(connectorId, scenarioId)?.nodes[0] as
    { data?: { delaySeconds?: number } } | undefined;
  return node?.data?.delaySeconds ?? null;
}

/** {@link targeted} under a chosen id, so one connector can hold two. */
function targetedNamed(id: string, targetId: number, delayMs: number): string {
  const parsed = JSON.parse(targeted(targetId, delayMs)) as Record<
    string,
    unknown
  >;
  return JSON.stringify({ ...parsed, id });
}

/** The `delaySeconds` of one named instance, when a connector holds several. */
function delayOf(
  svc: CLIChargePointService,
  connectorId: number,
  scenarioId: string,
): number | null {
  const node = svc.getScenario(connectorId, scenarioId)?.nodes[0] as
    { data?: { delaySeconds?: number } } | undefined;
  return node?.data?.delaySeconds ?? null;
}

/** A scenario already targeting connector 1, loaded as-is by a one-connector
 *  `--scenario` run — the case where `fanOut` used to be false forever. */
function targeted(targetId: number, delayMs: number): string {
  const parsed = JSON.parse(template(delayMs)) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    id: "targeted-scenario",
    targetType: "connector",
    targetId,
  });
}

describe("--watch over a startup scenario file (#314)", () => {
  it("re-reads --scenario-template-file and reinstantiates it per connector", async () => {
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
    });
    const svc = new CLIChargePointService({
      cpId: "cp314",
      wsUrl: csms.url,
      connectors: 2,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-startup-"));
    const templateFile = join(tmpDir, "template.json");
    writeFileSync(templateFile, template(11));

    try {
      await svc.connect();
      // Nothing is watched until `runStartupScenario` registers, which happens
      // inside the bootstrap loop. The startup summary used to be logged before
      // that loop, so a daemon whose only watched file was its `--scenario`
      // reported "0 file(s)" and then watched one (#314).
      expect(fileReload.watchedPaths()).toEqual([]);
      const boot = await csms.waitForCall("BootNotification");
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: null,
          scenarioTemplate: null,
          scenarioTemplateFile: templateFile,
          scenarioConnector: "all",
        },
        2,
        fileReload,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;

      // One registration per connector, all on the one file.
      expect(fileReload.watchedPaths()).toEqual([templateFile]);
      expect(loadedDelay(svc, 1)).toBe(11);
      expect(loadedDelay(svc, 2)).toBe(11);
      const idsBefore = [
        svc.listScenarios(1)[0]?.scenarioId,
        svc.listScenarios(2)[0]?.scenarioId,
      ];
      expect(idsBefore[0]).not.toBe(idsBefore[1]);

      backend.save(templateFile, template(22));
      await waitFor(
        () => loadedDelay(svc, 1) === 22 && loadedDelay(svc, 2) === 22,
        "both connectors to pick up the edited template",
      );

      // The per-connector rewrite ran again: without it both connectors would
      // come back pointing at the file's own targetId (1), and connector 2
      // would be driving connector 1.
      expect(svc.getScenario(1, idsBefore[0] as string)?.targetId).toBe(1);
      expect(svc.getScenario(2, idsBefore[1] as string)?.targetId).toBe(2);

      // Still one instance per connector, under the ids they were loaded as:
      // a reload replaces, it never adds.
      expect(svc.listScenarios(1)).toHaveLength(1);
      expect(svc.listScenarios(2)).toHaveLength(1);
      expect([
        svc.listScenarios(1)[0]?.scenarioId,
        svc.listScenarios(2)[0]?.scenarioId,
      ]).toEqual(idsBefore);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-evaluates the target when --scenario's own targetId is edited", async () => {
    // A one-connector `--scenario` already pointed at that connector is loaded
    // as-is — no per-connector rewrite. That decision used to be captured once,
    // so editing `targetId` in the file left the definition registered on the
    // original connector while its executor derived expectations from the new
    // target: waiting on a connector it was not attached to, and never firing.
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
    });
    const svc = new CLIChargePointService({
      cpId: "cp314-target",
      wsUrl: csms.url,
      connectors: 2,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-target-"));
    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(scenarioFile, targeted(1, 11));

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: scenarioFile,
          scenarioTemplate: null,
          scenarioTemplateFile: null,
          scenarioConnector: "1",
        },
        2,
        fileReload,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;

      // Loaded as-is: the file already targets connector 1, so the id is the
      // file's own rather than an instantiated one.
      const scenarioId = svc.listScenarios(1)[0]?.scenarioId;
      expect(scenarioId).toBe("targeted-scenario");
      expect(svc.getScenario(1, "targeted-scenario")?.targetId).toBe(1);

      // The operator repoints the file at connector 2. The definition stays on
      // connector 1 (a reload never moves a scenario), so it has to be rewritten
      // back onto the connector it is registered for — otherwise the executor
      // waits on connector 2 while attached to connector 1.
      backend.save(scenarioFile, targeted(2, 22));
      // Waits on the *graph*, not on targetId — targetId is already 1, so a
      // predicate on it would be satisfied before the reload had even run.
      await waitFor(
        () => loadedDelay(svc, 1) === 22,
        "the edited scenario file to be reloaded",
      );
      // Re-targeted back onto the connector it is registered for. Without the
      // per-definition re-evaluation this reads 2, and the executor then waits
      // on a connector the scenario is not attached to.
      expect(svc.getScenario(1, "targeted-scenario")?.targetId).toBe(1);
      expect(svc.getScenario(1, "targeted-scenario")?.targetType).toBe(
        "connector",
      );
      // …and it is the edited graph, not the old one held in place.
      expect(loadedDelay(svc, 1)).toBe(22);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("does not persist its registrations, because only the bootstrap can restore them", async () => {
    // A `watched_scenario_files` row carries a path and an id — never the
    // `prepare` callback that rewrites the template per connector. Persisted,
    // the startup fan-out came back on the next `--state-db` boot as one
    // prepare-less watch per connector, under the *previous* run's ids, each
    // ready to reload the file's own targetId over the prepared copies while
    // the bootstrap built fresh instances alongside them. The bootstrap runs on
    // every boot and is the only thing that can restore these correctly, so
    // they are deliberately not written down (#314).
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-startup-db-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const svc = new CLIChargePointService({
      cpId: "cp314db",
      wsUrl: csms.url,
      connectors: 2,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);
    const templateFile = join(tmpDir, "template.json");
    writeFileSync(templateFile, template(11));

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: null,
          scenarioTemplate: null,
          scenarioTemplateFile: templateFile,
          scenarioConnector: "all",
        },
        2,
        fileReload,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;

      // Watched right now — and nothing written down.
      expect(fileReload.watchedPaths()).toEqual([templateFile]);
      expect(listWatchedScenarioFiles(database)).toEqual([]);
      expect(loadedDelay(svc, 1)).toBe(11);
      expect(loadedDelay(svc, 2)).toBe(11);
      const idsBefore = [
        svc.listScenarios(1)[0]?.scenarioId as string,
        svc.listScenarios(2)[0]?.scenarioId as string,
      ];

      // `--scenario` is the same story: its `prepare` decides per reload
      // whether the file already targets the connector, and no row can say so.
      const scenarioFile = join(tmpDir, "scenario.json");
      writeFileSync(scenarioFile, targeted(1, 11));
      await runStartupScenario(
        svc,
        {
          scenario: scenarioFile,
          scenarioTemplate: null,
          scenarioTemplateFile: null,
          scenarioConnector: "all",
        },
        2,
        fileReload,
      );
      expect(fileReload.watchedPaths()).toContain(scenarioFile);
      expect(listWatchedScenarioFiles(database)).toEqual([]);

      // The reloader restarts (the bootstrap has not re-run yet) and restores
      // whatever the database says it was watching.
      fileReload.close();
      const restored = new FileReloadManager(registry, {
        watcher: new FileWatcher({
          debounceMs: 5,
          watchFactory: backend.factory,
        }),
        log: () => {},
        database,
      });
      try {
        restored.syncFromRegistry();
        restored.restoreScenarioWatches();
        expect(restored.watchedPaths()).toEqual([]);

        // Nothing is watching the template, so an edit changes nothing. With
        // the rows persisted, this reload would land prepare-less: both
        // connectors rewritten to the file's own targetId, connector 2 driving
        // connector 1.
        backend.save(templateFile, template(22));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(delayOf(svc, 1, idsBefore[0])).toBe(11);
        expect(delayOf(svc, 2, idsBefore[1])).toBe(11);
        expect(svc.getScenario(2, idsBefore[1])?.targetId).toBe(2);
      } finally {
        restored.close();
      }
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("deletes a control-plane row for a key it takes over", async () => {
    // The complement of "startup registrations are not persisted". Writing no
    // new row is only half of it: the same (cpId, connectorId, scenarioId) can
    // already carry a row from a control-plane `load_scenario { file }` in an
    // earlier run. Left behind, the next restart restores that abandoned file
    // and applies it *before* the bootstrap registers the configured scenario —
    // and a matching trigger can auto-start the stale graph instead (#314).
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-takeover-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const svc = new CLIChargePointService({
      cpId: "cp314-takeover",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(scenarioFile, targeted(1, 11));
    const abandoned = join(tmpDir, "from-an-earlier-run.json");
    writeFileSync(abandoned, targeted(1, 99));
    // The row a previous run's control-plane load left under this exact key —
    // `--scenario` keeps the file's own id when it already targets the
    // connector, so the two collide.
    rememberWatchedScenarioFile(
      database,
      "cp314-takeover",
      1,
      "targeted-scenario",
      abandoned,
    );
    expect(listWatchedScenarioFiles(database)).toHaveLength(1);

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: scenarioFile,
          scenarioTemplate: null,
          scenarioTemplateFile: null,
          scenarioConnector: "1",
        },
        1,
        fileReload,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;

      expect(svc.listScenarios(1)[0]?.scenarioId).toBe("targeted-scenario");
      expect(fileReload.watchedPaths()).toEqual([scenarioFile]);
      // The stale row is gone, so a restart has nothing to reattach.
      expect(listWatchedScenarioFiles(database)).toEqual([]);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("the bootstrap asserts ownership before the rows are read", async () => {
    // Why `restoreScenarioWatches()` moved after the bootstrap loop. The stored
    // row names the same scenario id the operator's `--scenario` uses, and the
    // file it points at was edited while the daemon was down. Restored first,
    // that abandoned graph is reconciled onto the connector — and if its
    // trigger matches it auto-starts, after which the real startup load
    // replaces only the definition and `startScenarioIfNotAlreadyActive` sees
    // the stale executor already running. Run the bootstrap first and its
    // takeover deletes the row before anything reads it, so the two rules
    // compose without a third that knows which keys are startup-owned (#314).
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-order-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const svc = new CLIChargePointService({
      cpId: "cp314-order",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(scenarioFile, targeted(1, 11));
    const abandoned = join(tmpDir, "abandoned.json");
    writeFileSync(abandoned, targeted(1, 99));
    rememberWatchedScenarioFile(
      database,
      "cp314-order",
      1,
      "targeted-scenario",
      abandoned,
    );

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: scenarioFile,
          scenarioTemplate: null,
          scenarioTemplateFile: null,
          scenarioConnector: "1",
        },
        1,
        fileReload,
        database,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;

      // The order `startServer` uses: bootstrap, then restore.
      fileReload.restoreScenarioWatches();

      // Only the configured file is watched, and the connector holds its graph
      // rather than the abandoned one.
      expect(fileReload.watchedPaths()).toEqual([scenarioFile]);
      expect(delayOf(svc, 1, "targeted-scenario")).toBe(11);
      expect(listWatchedScenarioFiles(database)).toEqual([]);

      // …and the abandoned file is inert: an edit to it changes nothing.
      backend.save(abandoned, targeted(1, 77));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(delayOf(svc, 1, "targeted-scenario")).toBe(11);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restoring first is what the order protects against", async () => {
    // The same fixture with the two steps swapped, so the ordering above is
    // shown to be load-bearing rather than incidental: the abandoned file wins
    // the key, and the connector ends up on its graph.
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-order-bad-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const svc = new CLIChargePointService({
      cpId: "cp314-order-bad",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const abandoned = join(tmpDir, "abandoned.json");
    writeFileSync(abandoned, targeted(1, 99));
    // As a `--state-db` restore would leave it: the definition is back under
    // the id the startup flag will also use.
    svc.loadScenario(1, JSON.parse(targeted(1, 11)) as ScenarioDefinition);
    rememberWatchedScenarioFile(
      database,
      "cp314-order-bad",
      1,
      "targeted-scenario",
      abandoned,
    );

    try {
      fileReload.restoreScenarioWatches();
      // Restored first, the abandoned file is reconciled straight onto the
      // connector — before the bootstrap has had any say.
      expect(fileReload.watchedPaths()).toEqual([abandoned]);
      expect(delayOf(svc, 1, "targeted-scenario")).toBe(99);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("clears the row it takes over even with --watch off", async () => {
    // The third site of the "stored state is not watcher state" rule, found by
    // auditing the other two. Without `--watch` there is no reloader, so the
    // takeover deletion that lives inside `registerScenarioFile` never runs —
    // and the row survived a run whose `--scenario` had actually taken the key,
    // leaving a false fact for the next watched start to act on (#314).
    const csms = startMockCsms();
    const registry = new CPRegistry(new EventBus());
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-nowatch-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const svc = new CLIChargePointService({
      cpId: "cp314-nowatch",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(scenarioFile, targeted(1, 11));
    rememberWatchedScenarioFile(
      database,
      "cp314-nowatch",
      1,
      "targeted-scenario",
      join(tmpDir, "abandoned.json"),
    );
    expect(listWatchedScenarioFiles(database)).toHaveLength(1);

    try {
      await svc.connect();
      const boot = await csms.waitForCall("BootNotification");
      // No reloader: `--state-db` without `--watch`.
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: scenarioFile,
          scenarioTemplate: null,
          scenarioTemplateFile: null,
          scenarioConnector: "1",
        },
        1,
        null,
        database,
      );
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await runPromise;
      expect(svc.listScenarios(1)[0]?.scenarioId).toBe("targeted-scenario");
      expect(listWatchedScenarioFiles(database)).toEqual([]);
    } finally {
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("a registration made while the daemon was already serving survives the restore", async () => {
    // The hazard the ordering change bought. `Bun.serve` is bound before the
    // bootstrap runs, so the restore no longer executes in a quiet process: an
    // RPC arriving mid-bootstrap has already written its row and registered a
    // live watch. The row it wrote names the same file, so the damage is not a
    // wrong path — it is the *re-registration*, which arrives with
    // `loadedText: null` ("no baseline to trust") and immediately reconciles:
    // the definition that is already loaded is applied again, and while a run
    // is in flight it is deferred and re-installed when that run settles, which
    // can auto-start it a second time. One request, duplicate traffic (#314).
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-serving-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const events: string[] = [];
    fileReload.setSink((event) => events.push(event.outcome));
    const svc = new CLIChargePointService({
      cpId: "cp314-serving",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    // What an RPC does while the bootstrap is still awaiting its connections:
    // load the definition, register the file it came from, write the row.
    const live = join(tmpDir, "live.json");
    const liveText = targeted(1, 11);
    writeFileSync(live, liveText);
    svc.loadScenario(1, JSON.parse(liveText) as ScenarioDefinition);
    fileReload.registerScenarioFile({
      filePath: live,
      cpId: "cp314-serving",
      connectorId: 1,
      scenarioId: "targeted-scenario",
      loadedText: liveText,
    });
    // Registering a file whose bytes are already loaded is silent.
    expect(events).toEqual([]);
    expect(listWatchedScenarioFiles(database)).toHaveLength(1);

    try {
      // The bootstrap reaches its end and restores over a serving daemon.
      fileReload.restoreScenarioWatches();

      // Nothing happened: the live registration kept its baseline, so the
      // definition already running was not re-applied. Without the guard the
      // row is re-registered with no baseline and this reports one `applied`.
      expect(events).toEqual([]);
      expect(fileReload.watchedPaths()).toEqual([live]);
      expect(delayOf(svc, 1, "targeted-scenario")).toBe(11);
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("holds a startup-owned charge point's rows back to the second pass", async () => {
    // The two-phase restore. The first pass runs before restored charge points
    // dial, so their persisted connect-triggered scenarios start on the file as
    // it reads now — but it must not touch a charge point a startup flag is
    // about to load onto, or the abandoned row's graph lands (and can start)
    // before the flag has claimed the key. Those rows wait for the pass after
    // the bootstrap, by which time the takeover has deleted the ones the flags
    // claimed (#314).
    const registry = new CPRegistry(new EventBus());
    const backend = new TestWatchBackend();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-watch-2phase-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const fileReload = new FileReloadManager(registry, {
      watcher: new FileWatcher({
        debounceMs: 5,
        watchFactory: backend.factory,
      }),
      log: () => {},
      database,
    });
    const svc = new CLIChargePointService({
      cpId: "cp314-2phase",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    registry.registerExisting(svc);

    // As a `--state-db` restore leaves it: the definition is back under the id
    // the startup flag will also use, and the row points at the old file, which
    // was edited while the daemon was down.
    const abandoned = join(tmpDir, "abandoned.json");
    writeFileSync(abandoned, targeted(1, 99));
    svc.loadScenario(1, JSON.parse(targeted(1, 11)) as ScenarioDefinition);
    rememberWatchedScenarioFile(
      database,
      "cp314-2phase",
      1,
      "targeted-scenario",
      abandoned,
    );

    try {
      // A second scenario on the same charge point, from a file the startup
      // flag will never claim. Skipping the whole charge point left this one
      // unwatched right up to the moment it dialled, so it auto-started from
      // the database copy rather than the file as it reads now.
      const unrelated = join(tmpDir, "unrelated.json");
      writeFileSync(unrelated, targetedNamed("other-scenario", 1, 55));
      svc.loadScenario(
        1,
        JSON.parse(
          targetedNamed("other-scenario", 1, 44),
        ) as ScenarioDefinition,
      );
      rememberWatchedScenarioFile(
        database,
        "cp314-2phase",
        1,
        "other-scenario",
        unrelated,
      );

      // First pass, skipping only the id the bootstrap will claim.
      fileReload.restoreScenarioWatches({
        // The predicate the daemon builds: this scenario id is one the startup
        // flag will claim on this charge point.
        skip: (row) =>
          row.cp_id === "cp314-2phase" &&
          row.scenario_id === "targeted-scenario",
      });
      // The unrelated scenario is watched *and* reconciled to the file's
      // current contents, before anything dials.
      expect(fileReload.watchedPaths()).toEqual([unrelated]);
      expect(delayOf(svc, 1, "other-scenario")).toBe(55);
      expect(delayOf(svc, 1, "targeted-scenario")).toBe(11);
      // The claimed row is left untouched for the second pass — neither applied
      // nor pruned.
      expect(listWatchedScenarioFiles(database)).toHaveLength(2);

      // Second pass, after the bootstrap. Nothing claimed the key in this
      // fixture, so the row is genuinely a previous run's and is restored.
      fileReload.restoreScenarioWatches();
      expect(fileReload.watchedPaths().sort()).toEqual(
        [abandoned, unrelated].sort(),
      );
    } finally {
      fileReload.close();
      svc.disconnect();
      registry.shutdownAll();
      database.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("rebuilds the fleet without dialling until it is told to", async () => {
    // The seam the two-phase restore needs. `restoreFromDatabase` used to dial
    // inside its own loop, so a restored charge point's boot gate could open —
    // and its persisted connect-triggered scenario start — before `--watch` had
    // re-read the file it came from (#314).
    const csms = startMockCsms();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-defer-dial-"));
    const database = BunSqliteDatabase.open(join(tmpDir, "state.sqlite"));
    const first = new CPRegistry(new EventBus(), database);
    first.create({
      cpId: "cp314-dial",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
    first.shutdownAll();

    const second = new CPRegistry(new EventBus(), database);
    try {
      const restored = second.restoreFromDatabase({ connect: false });
      expect(restored).toEqual(["cp314-dial"]);
      // Nothing dialled: no BootNotification has reached the CSMS.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        (csms.received as unknown[]).filter(
          (frame) => Array.isArray(frame) && frame[2] === "BootNotification",
        ),
      ).toHaveLength(0);

      // …until the caller says so.
      second.connectRestored(restored);
      await csms.waitForCall("BootNotification");
    } finally {
      second.shutdownAll();
      database.close();
      await csms.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("claims only the ids a startup flag will actually reuse", async () => {
    // The narrow skip is only as good as this prediction, and it has to agree
    // with the `prepare` that `runStartupScenario` builds — which is why both
    // read the same `scenarioFileTargetsConnector` rule rather than each
    // carrying a copy of it (#314).
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-claimed-"));
    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(scenarioFile, targeted(1, 11));
    const templateFile = join(tmpDir, "template.json");
    writeFileSync(templateFile, template(11));

    try {
      const base = {
        scenario: null,
        scenarioTemplate: null,
        scenarioTemplateFile: null,
        scenarioConnector: "all",
      };
      // One connector, and the file already targets it: loaded as-is, so its
      // own id is the key it will claim.
      expect([
        ...startupClaimedScenarioIds({ ...base, scenario: scenarioFile }, 1),
      ]).toEqual(["targeted-scenario"]);
      // Two connectors: every copy is instantiated with a fresh
      // `Date.now()`-bearing id, so no stored row can collide.
      expect([
        ...startupClaimedScenarioIds({ ...base, scenario: scenarioFile }, 2),
      ]).toEqual([]);
      // …unless the operator narrowed the fan-out back to one connector.
      expect([
        ...startupClaimedScenarioIds(
          { ...base, scenario: scenarioFile, scenarioConnector: "1" },
          2,
        ),
      ]).toEqual(["targeted-scenario"]);
      // A template file always instantiates, and so claims nothing.
      expect([
        ...startupClaimedScenarioIds(
          { ...base, scenarioTemplateFile: templateFile },
          1,
        ),
      ]).toEqual([]);
      // An unreadable file claims nothing rather than guessing: every row is
      // then restored in the first pass, exactly as with no flag at all.
      expect([
        ...startupClaimedScenarioIds(
          { ...base, scenario: join(tmpDir, "missing.json") },
          1,
        ),
      ]).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("holds back the dial only for charge points the bootstrap will dial", async () => {
    // The residual left over from the two-phase restore. A restored charge
    // point whose id a startup flag claims still holds the previous run's copy
    // of that scenario, and it auto-starts on boot — so dialling it during the
    // restore put the whole bootstrap loop between that start and the flag's
    // load. Held back, the two are adjacent.
    const claimed = new Map<string, ReadonlySet<string>>([
      ["cp-claimed", new Set(["targeted-scenario"])],
      ["cp-untouched", new Set<string>()],
    ]);
    const restored = ["cp-claimed", "cp-untouched", "cp-not-in-fleet"];

    // With `--auto-connect` the bootstrap loop dials, so the claimed one waits.
    expect([...restoredDialsToDefer(restored, claimed, true)]).toEqual([
      "cp-claimed",
    ]);
    // Without it nothing else would dial, and `runStartupScenario` would spend
    // its whole boot-accepted timeout on a charge point this deliberately left
    // unconnected — so the hold-back does not apply.
    expect([...restoredDialsToDefer(restored, claimed, false)]).toEqual([]);
    // A charge point with no claimed ids is never held back either way.
    expect(
      restoredDialsToDefer(restored, claimed, true).has("cp-untouched"),
    ).toBe(false);
    expect(
      restoredDialsToDefer(restored, claimed, true).has("cp-not-in-fleet"),
    ).toBe(false);
  });
});
