import { describe, it, expect } from "bun:test";
import type * as fsTypes from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { CLIChargePointService } from "../../service";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { FileReloadManager } from "../FileReloadManager";
import { FileWatcher, type WatchFactory } from "../FileWatcher";
import { runStartupScenario } from "../startServer";
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
});
