import { afterEach, describe, expect, it } from "bun:test";
import type * as fsTypes from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import {
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import { ARRAY_MAX_ITEMS } from "../../../protocol/limits";
import { rememberWatchedScenarioFile } from "../watchedScenarioFiles";
import type { WatchFactory } from "../FileWatcher";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * A hand-driven stand-in for `fs.watch`.
 *
 * The files below are real and are really re-read; only the *notification* is
 * synthetic. Real watch events are asynchronous, coalesced differently per
 * platform, and absent entirely on a host that has run out of kqueue
 * descriptors — which would make this suite report on the machine instead of on
 * the reload rules it exists to pin down. `FileWatcher`'s own suite covers the
 * watching itself.
 */
class TestWatchBackend {
  private readonly listeners = new Map<
    string,
    Set<(eventType: string, filename: string | null) => void>
  >();

  /** Called as a directory watch is established. Lets a test write to a file
   *  in the window between the caller loading it and the watch starting. */
  onWatch: ((directory: string) => void) | null = null;

  readonly factory: WatchFactory = (directory, listener) => {
    this.onWatch?.(directory);
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

  /** Write the file and tell whoever is watching its directory. */
  save(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents);
    const listeners = this.listeners.get(path.dirname(filePath));
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener("change", path.basename(filePath));
    }
  }

  watchedDirectories(): string[] {
    return [...this.listeners]
      .filter(([, set]) => set.size > 0)
      .map(([dir]) => dir);
  }
}

/**
 * A CSMS that accepts everything.
 *
 * The mid-transaction rule cannot be tested against a disconnected charge
 * point: a local start is gated on Authorize.conf, so without a CSMS no
 * transaction ever opens and a "deferred while charging" assertion would pass
 * for the wrong reason. This answers every CALL so a real session can be opened
 * and closed.
 */
function startAcceptingCsms(): { csms: MockCsms; stop: () => void } {
  const csms = startMockCsms();
  const answered = new Set<string>();
  let nextTransactionId = 1_000;
  const timer = setInterval(() => {
    for (const frame of csms.received as OcppFrame[]) {
      if (!Array.isArray(frame) || frame[0] !== 2) continue;
      const messageId = frame[1] as string;
      if (answered.has(messageId)) continue;
      answered.add(messageId);
      csms.replyCallResult(
        messageId,
        resultFor(frame[2] as string, ++nextTransactionId),
      );
    }
  }, 5);
  return { csms, stop: () => clearInterval(timer) };
}

function resultFor(action: string, transactionId: number): unknown {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: new Date().toISOString(),
        interval: 300,
      };
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction":
      return { transactionId, idTagInfo: { status: "Accepted" } };
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    default:
      return {};
  }
}

const servers: TestServer[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];
const databases: BunSqliteDatabase[] = [];
const csmsList: Array<{ csms: MockCsms; stop: () => void }> = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) {
    const entry = csmsList.pop();
    entry?.stop();
    await entry?.csms.stop();
  }
  while (databases.length > 0) databases.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function csmsUrl(): string {
  const entry = startAcceptingCsms();
  csmsList.push(entry);
  return entry.csms.url;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filereload-"));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

async function startWatchingServer(
  backend: TestWatchBackend,
  database: BunSqliteDatabase | null = null,
): Promise<TestServer> {
  const server = await startTestServer({
    database,
    watch: { debounceMs: 5, watchFactory: backend.factory },
  });
  servers.push(server);
  return server;
}

async function openClient(server: TestServer): Promise<Socket> {
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return socket;
}

function rpc(
  socket: Socket,
  method: string,
  params: Record<string, unknown> = {},
  cpId?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
      5_000,
    );
    socket.emit(
      "rpc",
      {
        id: `${method}-${Math.random()}`,
        method,
        params,
        ...(cpId ? { cpId } : {}),
      },
      (ack: { ok?: boolean; result?: unknown; error?: unknown }) => {
        clearTimeout(timer);
        if (ack?.ok === false) {
          reject(new Error(`${method} failed: ${JSON.stringify(ack.error)}`));
          return;
        }
        resolve((ack?.result ?? {}) as Record<string, unknown>);
      },
    );
  });
}

interface ReloadEvent {
  readonly kind: string;
  readonly target?: string;
  readonly outcome?: string;
  readonly cpId?: string;
  readonly scenarioId?: string;
  readonly error?: string | null;
}

function collectReloadEvents(socket: Socket): ReloadEvent[] {
  const seen: ReloadEvent[] = [];
  socket.on("event", (envelope: ReloadEvent) => {
    if (envelope?.kind === "file-reload") seen.push(envelope);
  });
  return seen;
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

/**
 * Create a charge point over the control plane, against its own accepting CSMS,
 * and wait until its boot gate is open.
 *
 * One CSMS per charge point: the mock replies on the most recent connection, so
 * two charge points sharing one would have their answers crossed.
 */
async function createConnectedCp(
  server: TestServer,
  socket: Socket,
  cpId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await rpc(socket, "cp.create", {
    cpId,
    wsUrl: csmsUrl(),
    connectors: 1,
    autoConnect: true,
    ...extra,
  });
  const service = server.registry.get(cpId);
  if (!service) throw new Error(`${cpId} was not registered`);
  await service.waitForBootAccepted(1);
}

/** Open a session and report the tag the charge point presented. */
async function openSession(
  server: TestServer,
  cpId: string,
  tagId?: string,
): Promise<string | null> {
  const service = server.registry.get(cpId);
  if (!service) throw new Error(`${cpId} is not registered`);
  service.startTransaction(1, tagId);
  await waitFor(
    () => service.hasOpenTransaction(1),
    `a transaction to open on ${cpId}`,
  );
  return (
    service.getStatus().connectors.find((c) => c.id === 1)?.transactionTagId ??
    null
  );
}

async function closeSession(server: TestServer, cpId: string): Promise<void> {
  const service = server.registry.get(cpId);
  if (!service) throw new Error(`${cpId} is not registered`);
  service.stopTransaction(1);
  await waitFor(
    () => !service.hasOpenTransaction(1),
    `the transaction on ${cpId} to close`,
  );
}

/** The tag the next session would present, leaving nothing open behind. */
async function drawnTag(
  server: TestServer,
  cpId: string,
): Promise<string | null> {
  const tag = await openSession(server, cpId);
  await closeSession(server, cpId);
  return tag;
}

function scenario(id: string, delayMs: number): string {
  return JSON.stringify({
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "n1",
        type: "delay",
        position: { x: 0, y: 0 },
        data: { duration: delayMs },
      },
    ],
    edges: [],
  });
}

/**
 * A scenario that actually runs: a `start` node walking into a single `delay`.
 *
 * `scenario()` above has no start node, so `runScenario` would fail before the
 * first step — enough to load, not enough to test a run that ends normally.
 * `enabled: false` keeps `tryAutoStartForConnector` out of it: a start node
 * without `triggerOn` defaults to "connect", so every `loadScenario` (the
 * reload included) would otherwise kick off a run of its own.
 */
function runnableScenario(id: string, delaySeconds: number): string {
  return JSON.stringify({
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    enabled: false,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "start-1",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "delay-1",
        type: "delay",
        position: { x: 0, y: 100 },
        data: { label: "Wait", delaySeconds },
      },
    ],
    edges: [{ id: "e1", source: "start-1", target: "delay-1" }],
  });
}

/**
 * The same graph as {@link runnableScenario} but left auto-startable: a `start`
 * node with no `triggerOn` defaults to "connect", so `loadScenario` starts it
 * the moment it lands on an Available charge point. That is the ordinary shape
 * of a scenario file, and the one `run_scenario_file` used to choke on.
 */
function autoStartScenario(id: string, delaySeconds: number): string {
  const parsed = JSON.parse(runnableScenario(id, delaySeconds)) as Record<
    string,
    unknown
  >;
  delete parsed.enabled;
  delete parsed.trigger;
  return JSON.stringify(parsed);
}

describe("--watch reloads an idTag file (#314)", () => {
  it("re-reads the pool a charge point was created from and applies it live", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["BEFORE"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });

    // Created over the control plane, exactly as an operator or agent would:
    // the path has to survive parseCreateBody, the facade's toInitOptions and
    // the registry before anything can watch it.
    await createConnectedCp(server, socket, "CP-WATCH", {
      idTagPool: { file },
    });
    expect(server.registry.get("CP-WATCH")?.getInit().idTagFile).toBe(file);
    expect(backend.watchedDirectories()).toContain(dir);
    expect(await drawnTag(server, "CP-WATCH")).toBe("BEFORE");

    backend.save(file, JSON.stringify(["AFTER"]));
    await waitFor(() => events.length > 0, "a file-reload event");

    expect(events[0]).toMatchObject({
      kind: "file-reload",
      event: "file-reloaded",
      target: "id-tags",
      cpId: "CP-WATCH",
      outcome: "applied",
      error: null,
    });
    expect(await drawnTag(server, "CP-WATCH")).toBe("AFTER");
  });

  it("keeps the previous pool when the edited file no longer parses", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["GOOD"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-BAD", {
      idTagPool: { file },
    });

    backend.save(file, "{ this is not json");
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.error).toContain("not valid JSON");
    // The point of the guard: a half-saved file must not empty the pool.
    expect(await drawnTag(server, "CP-BAD")).toBe("GOOD");

    // A file that parses but breaks the create-time rules is refused the same
    // way — the reload path must not be a looser second gate.
    backend.save(file, JSON.stringify([""]));
    await waitFor(() => events.length > 1, "a second rejection");
    expect(events[1]?.outcome).toBe("rejected");
    expect(await drawnTag(server, "CP-BAD")).toBe("GOOD");

    backend.save(file, JSON.stringify(["RECOVERED"]));
    await waitFor(() => events.length > 2, "recovery");
    expect(events[2]?.outcome).toBe("applied");
    expect(await drawnTag(server, "CP-BAD")).toBe("RECOVERED");
  });

  it("reloads every charge point sharing one file", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "fleet.json", JSON.stringify(["T1"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    for (const cpId of ["CP-A", "CP-B"]) {
      await createConnectedCp(server, socket, cpId, { idTagPool: { file } });
    }

    backend.save(file, JSON.stringify(["T2"]));
    await waitFor(() => events.length >= 2, "both charge points to reload");
    expect(await drawnTag(server, "CP-A")).toBe("T2");
    expect(await drawnTag(server, "CP-B")).toBe("T2");
  });

  it("stops watching a file once the charge point behind it is gone", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["X"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await rpc(socket, "cp.create", {
      cpId: "CP-GONE",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });
    expect(server.fileReload?.watchedPaths()).toEqual([file]);

    await rpc(socket, "cp.delete", { cpId: "CP-GONE" });
    expect(server.fileReload?.watchedPaths()).toEqual([]);
    expect(backend.watchedDirectories()).not.toContain(dir);
  });
});

describe("the idTag file path survives a daemon restart (#314)", () => {
  it("comes back from --state-db and is watched again", async () => {
    // The half-feature this guards against: the tags persist, the path does
    // not, and a restarted `--watch` daemon holds a frozen snapshot of a file
    // it believes it is watching.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["P1"]));
    const dbPath = path.join(dir, "state.sqlite");

    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-PERSIST",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });
    firstSocket.disconnect();
    await first.close();
    servers.pop();
    firstDb.close();
    databases.pop();

    const backend = new TestWatchBackend();
    const secondDb = BunSqliteDatabase.open(dbPath);
    databases.push(secondDb);
    const second = await startWatchingServer(backend, secondDb);
    expect(second.restored).toContain("CP-PERSIST");
    expect(second.registry.get("CP-PERSIST")?.getInit().idTagFile).toBe(file);
    expect(second.fileReload?.watchedPaths()).toEqual([file]);

    backend.save(file, JSON.stringify(["P2"]));
    await waitFor(
      () => second.registry.get("CP-PERSIST")?.getInit().idTags?.[0] === "P2",
      "the restored charge point to pick up the edit",
    );
  });
});

describe("--watch never mutates a charge point mid-transaction (#314)", () => {
  it("holds a scenario reload until the open transaction ends", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("watched-scenario", 1_000));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-TX");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-TX");
    expect(server.fileReload?.watchedPaths()).toContain(file);

    const service = server.registry.get("CP-TX");
    if (!service) throw new Error("CP-TX missing");
    // Guard the guard: without a genuinely open transaction the deferral
    // assertion below would pass for the wrong reason.
    expect(await openSession(server, "CP-TX", "TAG-TX")).toBe("TAG-TX");
    expect(service.hasOpenTransaction(1)).toBe(true);

    backend.save(file, scenario("ignored-id", 2_222));
    await waitFor(() => events.length > 0, "a deferral event");
    expect(events[0]).toMatchObject({
      target: "scenario",
      outcome: "deferred",
      cpId: "CP-TX",
      connectorId: 1,
      scenarioId: "watched-scenario",
    });
    // Nothing moved: the definition the connector holds is still the old one.
    expect(loadedDelay(server, "CP-TX", "watched-scenario")).toBe(1_000);

    await closeSession(server, "CP-TX");
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land",
    );
    expect(service.hasOpenTransaction(1)).toBe(false);
    expect(loadedDelay(server, "CP-TX", "watched-scenario")).toBe(2_222);
    // The edited file's own `id` is ignored: a reload replaces the scenario it
    // was loaded as, it never loads a second one alongside it.
    const ids = service.listScenarios(1).map((s) => s.scenarioId);
    expect(ids).toContain("watched-scenario");
    expect(ids).not.toContain("ignored-id");
  });

  it("applies a scenario reload immediately when nothing is in flight", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("idle-scenario", 10));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-IDLE",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-IDLE");

    backend.save(file, scenario("idle-scenario", 4_444));
    await waitFor(() => events.length > 0, "an applied event");
    expect(events[0]?.outcome).toBe("applied");
    expect(loadedDelay(server, "CP-IDLE", "idle-scenario")).toBe(4_444);
  });

  it("leaves a malformed scenario edit with the previous definition in place", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("keep-me", 77));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-BADSCEN",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-BADSCEN");

    backend.save(file, '{"id":"keep-me","nodes":');
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(loadedDelay(server, "CP-BADSCEN", "keep-me")).toBe(77);
  });
});

describe("without --watch nothing is re-read (#314)", () => {
  it("keeps the pool and the scenario a plain daemon loaded", async () => {
    const dir = tempDir();
    const tags = writeFile(dir, "tags.json", JSON.stringify(["ONLY"]));
    const scenarioFile = writeFile(dir, "s.json", scenario("static", 55));
    // No `watch` option: this is the default daemon.
    const server = await startTestServer();
    servers.push(server);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await createConnectedCp(server, socket, "CP-NOWATCH", {
      idTagPool: { file: tags },
    });
    await rpc(
      socket,
      "load_scenario",
      { connector: 1, file: scenarioFile },
      "CP-NOWATCH",
    );
    expect(server.fileReload).toBeNull();

    fs.writeFileSync(tags, JSON.stringify(["CHANGED"]));
    fs.writeFileSync(scenarioFile, scenario("static", 9_999));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toHaveLength(0);
    expect(await drawnTag(server, "CP-NOWATCH")).toBe("ONLY");
    expect(loadedDelay(server, "CP-NOWATCH", "static")).toBe(55);
  });
});

describe("a held scenario reload survives the run that blocked it (#314)", () => {
  it("applies the held definition when the run ends by itself", async () => {
    // The common path, and the one that used to drop the reload silently:
    // `scenario_completed` is emitted from inside the run, while the executor
    // is still registered, so a drain triggered by it re-deferred and then
    // waited for a further event that a run ending normally never sends.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", runnableScenario("held-run", 0.4));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-RUN");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RUN");

    const service = server.registry.get("CP-RUN");
    if (!service) throw new Error("CP-RUN missing");
    service.runScenario(1, "held-run");
    // Guard the guard: a reload that arrived after the run had already
    // finished would never be deferred, and would pass for the wrong reason.
    expect(service.isScenarioRunning("held-run")).toBe(true);
    // The run, not a transaction, is what holds this reload back — nothing
    // here ever emits transaction_stopped.
    expect(service.hasOpenTransaction(1)).toBe(false);

    backend.save(file, runnableScenario("held-run", 9));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );
    expect(loadedDelaySeconds(server, "CP-RUN", "held-run")).toBe(0.4);

    await waitFor(
      () => !service.isScenarioRunning("held-run"),
      "the run to finish on its own",
    );
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land once the run settled",
    );
    expect(loadedDelaySeconds(server, "CP-RUN", "held-run")).toBe(9);
  });

  it("applies the held definition when the run is stopped by hand", async () => {
    // The other terminal state, and since the run terminators left
    // DRAIN_EVENTS the post-cleanup hook is the *only* thing that releases a
    // reload held behind a manually stopped run. `stopScenario` drops the
    // executor synchronously and emits `scenario_completed` itself, which no
    // longer drains anything — so this pins the hook, not that event.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", runnableScenario("stopped-run", 30));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-STOP");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-STOP");

    const service = server.registry.get("CP-STOP");
    if (!service) throw new Error("CP-STOP missing");
    service.runScenario(1, "stopped-run");
    // A 30-second delay node: the run cannot end on its own inside this test,
    // so only the stop can be what releases the held definition.
    expect(service.isScenarioRunning("stopped-run")).toBe(true);
    expect(service.hasOpenTransaction(1)).toBe(false);

    backend.save(file, runnableScenario("stopped-run", 7));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );
    expect(loadedDelaySeconds(server, "CP-STOP", "stopped-run")).toBe(30);

    await rpc(
      socket,
      "stop_scenario",
      { connector: 1, scenarioId: "stopped-run" },
      "CP-STOP",
    );
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land after the manual stop",
    );
    expect(loadedDelaySeconds(server, "CP-STOP", "stopped-run")).toBe(7);
  });
});

describe("a scenario that is gone stays gone (#314)", () => {
  it("stops watching the file behind a removed scenario", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("removed-scenario", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-RM",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RM");
    expect(server.fileReload?.watchedPaths()).toContain(file);

    const removal = await rpc(
      socket,
      "remove_scenario",
      { connector: 1, scenarioId: "removed-scenario" },
      "CP-RM",
    );
    expect(removal.removed).toBe(true);
    expect(server.fileReload?.watchedPaths()).not.toContain(file);

    backend.save(file, scenario("removed-scenario", 22));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(0);
    const service = server.registry.get("CP-RM");
    expect(service?.listScenarios(1).map((s) => s.scenarioId)).not.toContain(
      "removed-scenario",
    );
  });

  it("does not re-create a scenario removed without going through the RPC", async () => {
    // Removal has paths the control plane never sees — a template instance
    // superseded by a newer one, the web console replacing a connector's whole
    // set. The reload path itself has to refuse to resurrect, not just the
    // handler that happens to know about the watcher.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("gone-scenario", 55));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-RM-DIRECT",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RM-DIRECT");

    const service = server.registry.get("CP-RM-DIRECT");
    if (!service) throw new Error("CP-RM-DIRECT missing");
    expect(service.removeScenario(1, "gone-scenario")).toBe(true);
    // Nothing has told the watcher yet: the file is still watched.
    expect(server.fileReload?.watchedPaths()).toContain(file);

    backend.save(file, scenario("gone-scenario", 66));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(service.listScenarios(1).map((s) => s.scenarioId)).not.toContain(
      "gone-scenario",
    );
    expect(events).toHaveLength(0);
    // …and the stale registration is dropped rather than retried forever.
    expect(server.fileReload?.watchedPaths()).not.toContain(file);
  });

  it("stops watching the file once an inline definition takes over the id", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("swapped", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-INLINE",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-INLINE");
    expect(server.fileReload?.watchedPaths()).toContain(file);

    await rpc(
      socket,
      "load_scenario",
      { connector: 1, scenario: JSON.parse(scenario("swapped", 33)) },
      "CP-INLINE",
    );
    expect(server.fileReload?.watchedPaths()).not.toContain(file);

    backend.save(file, scenario("swapped", 44));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(0);
    // The hand-written definition is the live one; the abandoned file is not.
    expect(loadedDelay(server, "CP-INLINE", "swapped")).toBe(33);
  });
});

describe("a relative idTagPool.file is stored resolved (#314)", () => {
  it("persists and watches the absolute path, not the caller's CWD-relative one", async () => {
    // A daemon restarted from another directory would otherwise re-resolve the
    // stored string against the new CWD and watch the wrong file, or nothing.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["REL"]));
    const relative = path.relative(process.cwd(), file);
    expect(path.isAbsolute(relative)).toBe(false);

    const dbPath = path.join(dir, "state.sqlite");
    const database = BunSqliteDatabase.open(dbPath);
    databases.push(database);
    const server = await startWatchingServer(new TestWatchBackend(), database);
    const socket = await openClient(server);
    await rpc(socket, "cp.create", {
      cpId: "CP-REL",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file: relative },
    });

    expect(server.registry.get("CP-REL")?.getInit().idTagFile).toBe(file);
    const rows = database.all<{ id_tag_file: string | null }>(
      "SELECT id_tag_file FROM charge_points WHERE cp_id = ?",
      ["CP-REL"],
    );
    expect(rows[0]?.id_tag_file).toBe(file);
    expect(server.fileReload?.watchedPaths()).toEqual([file]);
  });
});

describe("a file edited while the daemon was down is reconciled (#314)", () => {
  it("applies the current file to a charge point restored from --state-db", async () => {
    // The half-feature this guards against: the restore brings back the tags as
    // of the last time the daemon saw the file, and recording the file's
    // *current* bytes as already-seen would then suppress the operator's next
    // save of that same content as a duplicate — the pool would stay stale.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["BEFORE-DOWN"]));
    const dbPath = path.join(dir, "state.sqlite");

    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-DOWN",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });
    expect(first.registry.get("CP-DOWN")?.getInit().idTags).toEqual([
      "BEFORE-DOWN",
    ]);
    firstSocket.disconnect();
    await first.close();
    servers.pop();
    firstDb.close();
    databases.pop();

    // Edited with the daemon stopped — no watch is running to see it.
    fs.writeFileSync(file, JSON.stringify(["AFTER-DOWN"]));

    const backend = new TestWatchBackend();
    const secondDb = BunSqliteDatabase.open(dbPath);
    databases.push(secondDb);
    const second = await startWatchingServer(backend, secondDb);
    expect(second.restored).toContain("CP-DOWN");
    expect(second.registry.get("CP-DOWN")?.getInit().idTags).toEqual([
      "AFTER-DOWN",
    ]);
    // Reconciled through applyIdTagReload, so the DB agrees too — otherwise the
    // next restart would undo it.
    const rows = secondDb.all<{ id_tags: string | null }>(
      "SELECT id_tags FROM charge_points WHERE cp_id = ?",
      ["CP-DOWN"],
    );
    expect(JSON.parse(rows[0]?.id_tags ?? "null")).toEqual(["AFTER-DOWN"]);
  });

  it("leaves an unchanged file alone", async () => {
    // The other half of the contract: reconciling must not turn every restart
    // into a reload event for files nobody touched.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["SAME"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-SAME",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });
    // A second, unrelated charge point re-runs syncFromRegistry.
    await rpc(socket, "cp.create", {
      cpId: "CP-OTHER",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toHaveLength(0);
  });
});

describe("a console upload takes a connector away from its files (#314)", () => {
  it("stops watching after scenario.definitions.replace", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("uploaded", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-UPLOAD",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-UPLOAD");
    expect(server.fileReload?.watchedPaths()).toContain(file);

    // The console replaces the connector's whole set, keeping the id.
    await rpc(socket, "scenario.definitions.replace", {
      cpId: "CP-UPLOAD",
      connectorId: 1,
      definitions: [JSON.parse(scenario("uploaded", 33))],
    });
    expect(server.fileReload?.watchedPaths()).not.toContain(file);

    backend.save(file, scenario("uploaded", 44));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(0);
    // The upload is still what the connector holds.
    expect(loadedDelay(server, "CP-UPLOAD", "uploaded")).toBe(33);
  });
});

describe("a held reload survives the charge point being rebuilt (#314)", () => {
  it("applies once cp.update has replaced the charge point", async () => {
    // `cp.update` tears the service down and builds a replacement. That ends
    // the transaction holding the reload back, but it also takes the old
    // service's lifecycle handlers with it, so nothing would ever retry.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("rebuilt", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-REBUILD");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-REBUILD");

    expect(await openSession(server, "CP-REBUILD", "TAG-REBUILD")).toBe(
      "TAG-REBUILD",
    );
    backend.save(file, scenario("rebuilt", 22));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );
    expect(loadedDelay(server, "CP-REBUILD", "rebuilt")).toBe(11);

    // No transaction is ever stopped on the *new* service — the rebuild is the
    // only thing that ends the session.
    await rpc(socket, "cp.update", {
      cpId: "CP-REBUILD",
      wsUrl: server.registry.get("CP-REBUILD")?.getInit().wsUrl,
      connectors: 1,
      vendor: "RebuiltVendor",
    });
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land after the rebuild",
    );
    expect(loadedDelay(server, "CP-REBUILD", "rebuilt")).toBe(22);
    expect(server.registry.get("CP-REBUILD")?.getInit().vendor).toBe(
      "RebuiltVendor",
    );
  });
});

describe("run_scenario_file registers even when the file auto-starts (#314)", () => {
  it("watches a connect-triggered scenario the load already started", async () => {
    // `loadScenario` runs the auto-start gate, so on an Available charge point
    // the run is already in flight before the explicit start. That start used
    // to throw "already running" and fail the RPC, leaving the scenario loaded
    // and running but unwatched.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", autoStartScenario("auto-run", 30));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await createConnectedCp(server, socket, "CP-AUTO");
    const service = server.registry.get("CP-AUTO");
    if (!service) throw new Error("CP-AUTO missing");
    // `cp.create` seeds "Essential CP Behavior", which auto-starts on connect
    // and then owns the connector's auto-start slot (both the active-executor
    // gate and the dedup key). Clear it, so the gate actually reaches the file
    // under test — otherwise this test would prove nothing.
    for (const loaded of service.listScenarios(1)) {
      service.removeScenario(1, loaded.scenarioId);
    }

    const started = await rpc(
      socket,
      "run_scenario_file",
      { connector: 1, file },
      "CP-AUTO",
    );
    expect(started.scenarioId).toBe("auto-run");
    expect(service.isScenarioRunning("auto-run")).toBe(true);
    expect(server.fileReload?.watchedPaths()).toContain(file);
  });
});

describe("run_scenario_file runs what it was given, with what it was given (#314)", () => {
  it("honours strict on a file the auto-start gate would have started", async () => {
    // The regression this pins: with the gate left on, the load started the
    // scenario itself and the explicit start had nothing to do, so `strict`
    // went missing and the call reported success for a run it never began.
    const dir = tempDir();
    const file = writeFile(
      dir,
      "s.json",
      autoStartScenario("strict-run", 0.05),
    );
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await createConnectedCp(server, socket, "CP-STRICT");
    const service = server.registry.get("CP-STRICT");
    if (!service) throw new Error("CP-STRICT missing");
    // Clear the seeded default so the auto-start gate would reach this file —
    // otherwise the gate never fires and the test proves nothing.
    for (const loaded of service.listScenarios(1)) {
      service.removeScenario(1, loaded.scenarioId);
    }

    await rpc(
      socket,
      "run_scenario_file",
      { connector: 1, file, strict: true },
      "CP-STRICT",
    );
    await waitFor(
      () => service.getScenarioRunResult("strict-run") !== null,
      "the run to be recorded",
    );
    expect(service.getScenarioRunResult("strict-run")?.strict).toBe(true);
    expect(server.fileReload?.watchedPaths()).toContain(file);
  });

  it("refuses a scenario id that was already running before the call", async () => {
    // A wrong error beats a wrong success: reporting ok while never executing
    // the file the caller handed over is not something a caller can detect.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", autoStartScenario("busy-run", 30));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await createConnectedCp(server, socket, "CP-BUSY");
    const service = server.registry.get("CP-BUSY");
    if (!service) throw new Error("CP-BUSY missing");
    for (const loaded of service.listScenarios(1)) {
      service.removeScenario(1, loaded.scenarioId);
    }

    await rpc(socket, "run_scenario_file", { connector: 1, file }, "CP-BUSY");
    expect(service.isScenarioRunning("busy-run")).toBe(true);

    // A second call, same id, while the first run is still in flight.
    await expect(
      rpc(socket, "run_scenario_file", { connector: 1, file }, "CP-BUSY"),
    ).rejects.toThrow(/run_scenario_file failed/);
  });
});

describe("every charge point sharing a file is reconciled on restart (#314)", () => {
  it("applies the edit to each restored charge point, not just the first", async () => {
    // `restoreFromDatabase` re-creates the fleet one charge point at a time,
    // each firing its own registry sync. Reconciling once per *file* left every
    // charge point after the first holding the tags it was persisted with.
    const dir = tempDir();
    const file = writeFile(dir, "shared.json", JSON.stringify(["OLD"]));
    const dbPath = path.join(dir, "state.sqlite");

    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    for (const cpId of ["CP-SHARE-A", "CP-SHARE-B", "CP-SHARE-C"]) {
      await rpc(firstSocket, "cp.create", {
        cpId,
        wsUrl: csmsUrl(),
        connectors: 1,
        idTagPool: { file },
      });
    }
    firstSocket.disconnect();
    await first.close();
    servers.pop();
    firstDb.close();
    databases.pop();

    fs.writeFileSync(file, JSON.stringify(["NEW"]));

    const secondDb = BunSqliteDatabase.open(dbPath);
    databases.push(secondDb);
    const second = await startWatchingServer(new TestWatchBackend(), secondDb);
    for (const cpId of ["CP-SHARE-A", "CP-SHARE-B", "CP-SHARE-C"]) {
      expect(second.restored).toContain(cpId);
      expect(second.registry.get(cpId)?.getInit().idTags).toEqual(["NEW"]);
    }
  });
});

describe("a reload reaches the scenario editor (#314)", () => {
  it("pushes scenario-definitions-changed as well as file-reload", async () => {
    // The console subscribes through `subscribeScenarioDefinitions`, which is
    // the `scenario-definitions` scope — it never sees a `file-reload`
    // envelope, so an open editor kept showing the graph the daemon had
    // stopped executing.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("edited-live", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    interface DefinitionsEvent {
      readonly kind?: string;
      readonly cpId?: string;
      readonly connectorId?: number;
      readonly definitions?: ReadonlyArray<{
        readonly id?: string;
        readonly nodes?: ReadonlyArray<{ readonly data?: unknown }>;
      }>;
    }
    const definitionEvents: DefinitionsEvent[] = [];
    socket.on("event", (envelope: DefinitionsEvent) => {
      if (envelope?.kind === "scenario-definitions") {
        definitionEvents.push(envelope);
      }
    });
    await rpc(socket, "events.subscribe", { scope: "scenario-definitions" });
    await rpc(socket, "cp.create", {
      cpId: "CP-EDITOR",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-EDITOR");
    definitionEvents.length = 0;

    backend.save(file, scenario("edited-live", 22));
    await waitFor(
      () => definitionEvents.length > 0,
      "a scenario-definitions-changed push",
    );
    const pushed = definitionEvents.at(-1);
    expect(pushed?.cpId).toBe("CP-EDITOR");
    expect(pushed?.connectorId).toBe(1);
    const reloaded = pushed?.definitions?.find((d) => d.id === "edited-live");
    expect(
      (reloaded?.nodes?.[0]?.data as { duration?: number } | undefined)
        ?.duration,
    ).toBe(22);
  });
});

describe("a rejected save never becomes the baseline (#314)", () => {
  it("retries the same bytes after loadScenario refused them", async () => {
    // `loadScenario` can refuse a definition the file parsed fine (here: no
    // `id`, which its gate requires). Recording that text as already-seen made
    // the operator's next save of the *same* content an early return — no
    // retry, no event, and the connector left on the old graph until the bytes
    // changed again. The idTag path has always avoided this; the two must
    // agree.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("baseline-keep", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-BASELINE",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-BASELINE");

    // Structurally a scenario (id/nodes/edges) so it clears the watcher's own
    // shape check, but with a `targetType` `assertLoadableScenario` refuses —
    // so `loadScenario` throws and the reload is rejected after parsing.
    const unloadable = JSON.stringify({
      ...JSON.parse(scenario("baseline-keep", 22)),
      targetType: "galaxy",
    });
    backend.save(file, unloadable);
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(loadedDelay(server, "CP-BASELINE", "baseline-keep")).toBe(11);

    // Saving the very same bytes again must be judged afresh, not written off.
    backend.save(file, unloadable);
    await waitFor(
      () => events.length > 1,
      "a second rejection for the same bytes",
    );
    expect(events[1]?.outcome).toBe("rejected");

    // …and the next good save still lands.
    backend.save(file, scenario("baseline-keep", 33));
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the recovery to land",
    );
    expect(loadedDelay(server, "CP-BASELINE", "baseline-keep")).toBe(33);
  });

  it("never puts the file's own contents in the reload event", async () => {
    // A scenario file that does not parse used to be reported with the
    // runtime's message, which quotes the offending bytes — so a half-saved
    // file put a fragment of itself on the control plane, where any subscriber
    // can read it.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("no-echo", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-NOECHO",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-NOECHO");

    backend.save(file, "hunter2-topsecret-value not json at all");
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.error).toContain("not valid JSON");
    expect(events[0]?.error).not.toContain("hunter2-topsecret-value");
    expect(events[0]?.error).not.toContain("hunter2");
  });
});

describe("a write between the load and the watch is not lost (#314)", () => {
  it("picks up a write that lands while the watch is being established", async () => {
    // `load_scenario` reads the file, loads it, and only then registers a
    // watch. Nothing is looking in between: the write produces no event, and
    // the baseline ends up holding those very bytes, so the connector stays on
    // the old graph permanently rather than until the next edit.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("raced", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-RACE",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    // The window, reproduced at its narrowest: the file changes as the watch is
    // opened — after the definition was loaded, before anything can observe it.
    backend.onWatch = (watched) => {
      if (watched !== dir) return;
      backend.onWatch = null;
      fs.writeFileSync(file, scenario("raced", 22));
    };

    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RACE");

    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the missed write to be reconciled at registration",
    );
    expect(loadedDelay(server, "CP-RACE", "raced")).toBe(22);
  });

  it("keeps the loaded text as the baseline, not whatever is on disk later", async () => {
    // The wider half of the same window is between the *caller's* read and the
    // registration, which the caller closes by handing over the text it loaded.
    // Re-reading the file here instead would record the newer bytes as
    // already-seen and the edit would never be applied.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("handover", 11));
    const loadedText = fs.readFileSync(file, "utf-8");
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-HANDOVER",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      socket,
      "load_scenario",
      { connector: 1, scenario: JSON.parse(loadedText) },
      "CP-HANDOVER",
    );
    // The file has moved on since the caller read it.
    fs.writeFileSync(file, scenario("handover", 22));

    server.fileReload?.registerScenarioFile({
      filePath: file,
      cpId: "CP-HANDOVER",
      connectorId: 1,
      scenarioId: "handover",
      loadedText,
    });

    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the newer file to be applied at registration",
    );
    expect(loadedDelay(server, "CP-HANDOVER", "handover")).toBe(22);
  });
});

describe("the RPCs hand the watcher the text they loaded (#314)", () => {
  it("passes loadedText from load_scenario and run_scenario_file, and keeps it off the wire", async () => {
    // The window between the handler's read and the registration has no
    // injection point, so this pins the plumbing directly: whatever the handler
    // parsed is what the watcher's baseline must be. Re-reading the file inside
    // `registerScenarioFile` is what made a write in that window permanent.
    const dir = tempDir();
    const loadFile = writeFile(dir, "load.json", scenario("plumb-load", 11));
    const runFile = writeFile(dir, "run.json", scenario("plumb-run", 12));
    const loadText = fs.readFileSync(loadFile, "utf-8");
    const runText = fs.readFileSync(runFile, "utf-8");
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await rpc(socket, "cp.create", {
      cpId: "CP-PLUMB",
      wsUrl: csmsUrl(),
      connectors: 1,
    });

    const manager = server.fileReload;
    if (!manager) throw new Error("expected a --watch server");
    const seen: Array<{ scenarioId: string; loadedText?: string | null }> = [];
    const real = manager.registerScenarioFile.bind(manager);
    manager.registerScenarioFile = (registration) => {
      seen.push(registration);
      real(registration);
    };

    await rpc(
      socket,
      "load_scenario",
      { connector: 1, file: loadFile },
      "CP-PLUMB",
    );
    expect(seen.at(-1)?.scenarioId).toBe("plumb-load");
    expect(seen.at(-1)?.loadedText).toBe(loadText);

    const started = await rpc(
      socket,
      "run_scenario_file",
      { connector: 1, file: runFile },
      "CP-PLUMB",
    );
    expect(seen.at(-1)?.scenarioId).toBe("plumb-run");
    expect(seen.at(-1)?.loadedText).toBe(runText);
    // The result shape is exactly what the interface documents. `sourceText`
    // is handed over through a callback and is never a field on it, so no
    // dispatcher — socket.io or standalone JSON — can forget to strip it.
    expect(started).toEqual({ scenarioId: "plumb-run" });
  });
});

describe("a held reload lands even with auto-reset-to-Available off (#314)", () => {
  it("applies when the transaction is cleared, not when it is announced", async () => {
    // `ChargePoint.stopTransaction` emits `transaction_stopped` and the
    // `Finishing` status *before* `connector.stopTransaction()` clears the
    // transaction, so a drain keyed on either still sees `hasOpenTransaction()`
    // true. With auto-reset off there is no later `Available` to retry on, and
    // the valid definition used to sit deferred forever.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("no-reset", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-NORESET");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-NORESET");

    await rpc(
      socket,
      "set_auto_reset_to_available",
      { connector: 1, enabled: false },
      "CP-NORESET",
    );
    const service = server.registry.get("CP-NORESET");
    if (!service) throw new Error("CP-NORESET missing");
    // Guard the guard: with auto-reset still on, the connector would go
    // Available after the stop and the `connector_status` backstop would drain,
    // hiding the defect this test exists for.
    expect(service.getStatus().connectors[0]?.autoResetToAvailable).toBe(false);

    expect(await openSession(server, "CP-NORESET", "TAG-NR")).toBe("TAG-NR");
    backend.save(file, scenario("no-reset", 22));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );
    expect(loadedDelay(server, "CP-NORESET", "no-reset")).toBe(11);

    await closeSession(server, "CP-NORESET");
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land once the transaction was actually cleared",
    );
    expect(loadedDelay(server, "CP-NORESET", "no-reset")).toBe(22);
  });

  it("applies when reset_scenario drops the transaction", async () => {
    // `resetScenario` clears the transaction through the setter, which emits no
    // `transactionChange` at all — so it needs its own announcement or a reload
    // held behind that transaction has nothing to release it.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("reset-drop", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-RESET");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RESET");

    const service = server.registry.get("CP-RESET");
    if (!service) throw new Error("CP-RESET missing");
    expect(await openSession(server, "CP-RESET", "TAG-RS")).toBe("TAG-RS");
    backend.save(file, scenario("reset-drop", 22));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );

    service.resetScenario(1, "reset-drop");
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the held reload to land after the reset",
    );
    expect(loadedDelay(server, "CP-RESET", "reset-drop")).toBe(22);
  });
});

describe("a reload the control plane could not announce is refused (#314)", () => {
  it("rejects a scenario too large for the definitions envelope", async () => {
    // A scenario *file* has no size bound of its own, but the
    // `scenario-definitions-changed` envelope caps one definition at 256 KiB.
    // Applied first and validated second, the reload would land, be reported
    // `applied`, and then the push telling subscribers about it would throw and
    // be swallowed — an editor left drawing a graph the daemon had dropped.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("too-big", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-BIG",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-BIG");

    const oversized = JSON.parse(scenario("too-big", 22)) as {
      nodes: Array<Record<string, unknown>>;
      description?: string;
    };
    oversized.description = "x".repeat(300_000);
    backend.save(file, JSON.stringify(oversized));

    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.error).toContain("the control plane can carry");
    // The contract a malformed file gets: the previous definition stays.
    expect(loadedDelay(server, "CP-BIG", "too-big")).toBe(11);

    // …and a file back under the bound still lands.
    backend.save(file, scenario("too-big", 33));
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the recovery to land",
    );
    expect(loadedDelay(server, "CP-BIG", "too-big")).toBe(33);
  });
});

describe("an idTag file edited before the watch existed is still caught (#314)", () => {
  it("reads the baseline after the watch, not before it", async () => {
    // The scenario path closed this window in an earlier round; the idTag path
    // had the same read-then-watch ordering. A save landing in between produces
    // no event — nothing is looking — and the cached text is the pre-edit copy,
    // so the reconcile compares the old file against the pool it came from,
    // finds them equal, and leaves the charge point stale.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["BEFORE-WATCH"]));
    const backend = new TestWatchBackend();
    backend.onWatch = (watched) => {
      if (watched !== dir) return;
      backend.onWatch = null;
      // Written as the watch is opened: after the create-time read that gave
      // the charge point its pool, before anything can observe the change.
      fs.writeFileSync(file, JSON.stringify(["AFTER-WATCH"]));
    };
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await rpc(socket, "cp.create", {
      cpId: "CP-EARLY",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });

    await waitFor(
      () =>
        server.registry.get("CP-EARLY")?.getInit().idTags?.[0] ===
        "AFTER-WATCH",
      "the edit made while the watch was being established to be reconciled",
    );
  });
});

describe("a run's cleanup only ever tears down its own run (#314)", () => {
  it("does not let a stopped run delete the executor that replaced it", async () => {
    // `stopScenario` drops the executor synchronously and leaves that run's
    // `finally` queued. Anything that starts a replacement inside that window —
    // a drained reload whose definition auto-starts, which is what
    // `reset_scenario` used to do — would then have its executor, run id and
    // transcript deleted by the run it replaced.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", runnableScenario("supersede", 30));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await createConnectedCp(server, socket, "CP-SUPERSEDE");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-SUPERSEDE");

    const service = server.registry.get("CP-SUPERSEDE");
    if (!service) throw new Error("CP-SUPERSEDE missing");
    service.runScenario(1, "supersede");
    expect(service.isScenarioRunning("supersede")).toBe(true);

    // All in one tick, exactly as a synchronous drain would: stop, replace the
    // definition, start again. The stopped run's `finally` lands afterwards.
    service.stopScenario(1, "supersede");
    service.loadScenario(1, JSON.parse(runnableScenario("supersede", 30)));
    service.runScenario(1, "supersede");
    expect(service.isScenarioRunning("supersede")).toBe(true);

    // Let the superseded run's queued cleanup run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.isScenarioRunning("supersede")).toBe(true);
    // …and it did not record a terminal verdict over the live run either.
    expect(service.getScenarioStatus(1, "supersede")?.state).not.toBe(
      "completed",
    );
  });

  it("reset_scenario leaves the drain to the run it stopped", async () => {
    // The same hazard through the path that produced it: reset stops the run
    // and used to announce the settle synchronously, inside that window.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", runnableScenario("reset-race", 30));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-RESET-RACE");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-RESET-RACE");

    const service = server.registry.get("CP-RESET-RACE");
    if (!service) throw new Error("CP-RESET-RACE missing");
    service.runScenario(1, "reset-race");
    backend.save(file, runnableScenario("reset-race", 7));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );

    service.resetScenario(1, "reset-race");
    // Observed synchronously, because that is the whole point: the drain must
    // NOT have run inside `resetScenario`, where the stopped run's `finally` is
    // still queued behind it. Announcing there is what let a reloaded
    // definition auto-start into a window that then tore it down.
    expect(loadedDelaySeconds(server, "CP-RESET-RACE", "reset-race")).toBe(30);

    // Still drained — by the stopped run's own post-cleanup notification.
    await waitFor(
      () => loadedDelaySeconds(server, "CP-RESET-RACE", "reset-race") === 7,
      "the held reload to land after the stopped run's cleanup",
    );
    expect(events.some((e) => e.outcome === "applied")).toBe(true);
  });
});

describe("no drain runs inside a synchronous teardown (#314)", () => {
  it("applies a held reload after stopTransaction has finished unwinding", async () => {
    // `transactionChange` fires from inside `ChargePoint.stopTransaction`, with
    // the transaction already null but auto-reset and scheduled-availability
    // cleanup still to come. Draining there starts a new run against a
    // half-torn-down connector — an open gate is not the same as a finished
    // teardown, which is what four ordering bugs here had in common.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("teardown", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-TEARDOWN");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-TEARDOWN");

    const service = server.registry.get("CP-TEARDOWN");
    if (!service) throw new Error("CP-TEARDOWN missing");
    expect(await openSession(server, "CP-TEARDOWN", "TAG-TD")).toBe("TAG-TD");
    backend.save(file, scenario("teardown", 22));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "a deferral event",
    );

    service.stopTransaction(1);
    // Observed synchronously: the notification is queued, so nothing can have
    // been reloaded before `stopTransaction` finished its own cleanup.
    expect(loadedDelay(server, "CP-TEARDOWN", "teardown")).toBe(11);

    await waitFor(
      () => loadedDelay(server, "CP-TEARDOWN", "teardown") === 22,
      "the held reload to land once the teardown completed",
    );
  });
});

describe("a scenario file's watch survives a --state-db restart (#314)", () => {
  it("re-registers it and reconciles an edit made while the daemon was down", async () => {
    // The definition came back from the database either way; without the path
    // the *watch* did not, so the daemon held exactly the frozen snapshot of a
    // file it believed it was watching that the idTag half exists to prevent.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("persisted-watch", 11));
    const dbPath = path.join(dir, "state.sqlite");

    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-WATCH-PERSIST",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file },
      "CP-WATCH-PERSIST",
    );
    expect(first.fileReload?.watchedPaths()).toContain(file);
    firstSocket.disconnect();
    await first.close();
    servers.pop();
    firstDb.close();
    databases.pop();

    // Edited with nothing running.
    fs.writeFileSync(file, scenario("persisted-watch", 22));

    const backend = new TestWatchBackend();
    const secondDb = BunSqliteDatabase.open(dbPath);
    databases.push(secondDb);
    const second = await startWatchingServer(backend, secondDb);
    expect(second.restored).toContain("CP-WATCH-PERSIST");
    // Both directions: the row was written, and the restore reads it back.
    expect(second.fileReload?.watchedPaths()).toContain(file);
    // …and registering re-reads after the watch, so the edit made while the
    // daemon was down is applied rather than adopted as a silent baseline.
    await waitFor(
      () => loadedDelay(second, "CP-WATCH-PERSIST", "persisted-watch") === 22,
      "the edit made while the daemon was down to be reconciled",
    );

    // A later edit is watched too, not just the one-off reconcile.
    backend.save(file, scenario("persisted-watch", 33));
    await waitFor(
      () => loadedDelay(second, "CP-WATCH-PERSIST", "persisted-watch") === 33,
      "the restored watch to be live",
    );
  });

  it("drops the row for a scenario the operator removed", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("removed-watch", 11));
    const dbPath = path.join(dir, "state.sqlite");
    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-WATCH-RM",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file },
      "CP-WATCH-RM",
    );
    await rpc(
      firstSocket,
      "remove_scenario",
      { connector: 1, scenarioId: "removed-watch" },
      "CP-WATCH-RM",
    );
    expect(firstDb.all("SELECT path FROM watched_scenario_files")).toHaveLength(
      0,
    );
    firstSocket.disconnect();
    await first.close();
    servers.pop();
    firstDb.close();
    databases.pop();

    const secondDb = BunSqliteDatabase.open(dbPath);
    databases.push(secondDb);
    const second = await startWatchingServer(new TestWatchBackend(), secondDb);
    expect(second.fileReload?.watchedPaths()).toEqual([]);
  });
});

describe("a failed persist does not become the baseline (#314)", () => {
  it("reports the failure and judges the same bytes again", async () => {
    // `applyIdTagReload` mutates the live pool and then writes it back. A
    // transient SQLITE_BUSY or a full disk throws after the mutation: caching
    // the new text first left persisted state stale, emitted no outcome at all,
    // and made a retry of those same bytes an early return.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["P1"]));
    const dbPath = path.join(dir, "state.sqlite");
    const database = BunSqliteDatabase.open(dbPath);
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend, database);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-PERSIST-FAIL",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });

    // The write-back now fails; the in-memory mutation still happens first.
    database.close();

    backend.save(file, JSON.stringify(["P2"]));
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.cpId).toBe("CP-PERSIST-FAIL");

    // The same bytes again must be judged afresh, not written off as a
    // duplicate — the baseline records what landed, not what was read.
    backend.save(file, JSON.stringify(["P2"]));
    await waitFor(
      () => events.length > 1,
      "a second rejection for the same bytes",
    );
    expect(events[1]?.outcome).toBe("rejected");
  });
});

describe("cp.update to a different idTag file is reconciled (#314)", () => {
  it("does not treat the charge point as already checked against the new path", async () => {
    // The reconcile marker was keyed by charge point alone. `cp.update` deletes
    // and re-adds without an intervening sync, so the *new* path was filtered
    // out as "already reconciled" and its bytes became the baseline unapplied.
    const dir = tempDir();
    const first = writeFile(dir, "first.json", JSON.stringify(["FIRST"]));
    const second = writeFile(dir, "second.json", JSON.stringify(["SECOND"]));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    await rpc(socket, "cp.create", {
      cpId: "CP-SWAP",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file: first },
    });
    expect(server.registry.get("CP-SWAP")?.getInit().idTags).toEqual(["FIRST"]);

    // The second file moves on as its watch is opened — after `parseCreateBody`
    // read it for the update, before anything can observe the change.
    backend.onWatch = (watched) => {
      if (watched !== dir) return;
      backend.onWatch = null;
      fs.writeFileSync(second, JSON.stringify(["SECOND-EDITED"]));
    };
    await rpc(socket, "cp.update", {
      cpId: "CP-SWAP",
      wsUrl: server.registry.get("CP-SWAP")?.getInit().wsUrl,
      connectors: 1,
      idTagPool: { file: second },
    });

    await waitFor(
      () =>
        server.registry.get("CP-SWAP")?.getInit().idTags?.[0] ===
        "SECOND-EDITED",
      "the swapped-in file to be reconciled against the charge point",
    );
  });
});

describe("a rejected idTag reload is rejected everywhere (#314)", () => {
  it("leaves the live pool alone when the write-back fails", async () => {
    // The event, the running daemon and the stored state have to agree. With
    // the live pool mutated first, a failing write reported `rejected` while
    // the new tags were in force — and a restart quietly reverted them.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["KEEP"]));
    const dbPath = path.join(dir, "state.sqlite");
    const database = BunSqliteDatabase.open(dbPath);
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend, database);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-ATOMIC", {
      idTagPool: { file },
    });
    expect(await drawnTag(server, "CP-ATOMIC")).toBe("KEEP");

    database.close();
    backend.save(file, JSON.stringify(["NEVER-LANDED"]));
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");

    // Reported rejected, so it must actually be rejected: the charge point is
    // still drawing the pool it had.
    expect(server.registry.get("CP-ATOMIC")?.getInit().idTags).toEqual([
      "KEEP",
    ]);
    expect(await drawnTag(server, "CP-ATOMIC")).toBe("KEEP");
  });

  it("clears the baseline when a startup reconciliation could not be persisted", async () => {
    // The startup-reconciliation counterpart of the rule above. `idTagText` is
    // seeded with the file's current contents before the reconcile runs, so a
    // reconcile that could not be persisted must drop that cache — otherwise
    // the operator's next save of those same bytes is discarded as unchanged
    // and the database can never catch up.
    const dir = tempDir();
    const file = writeFile(dir, "tags.json", JSON.stringify(["BEFORE"]));
    const dbPath = path.join(dir, "state.sqlite");
    const database = BunSqliteDatabase.open(dbPath);
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend, database);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });

    // As the watch opens — after `parseCreateBody` read the file for the create,
    // and after the create row was written — the file moves on and the database
    // goes away. The reconcile that follows therefore has work to do and cannot
    // persist it.
    backend.onWatch = (watched) => {
      if (watched !== dir) return;
      backend.onWatch = null;
      fs.writeFileSync(file, JSON.stringify(["AFTER"]));
      database.close();
    };
    await rpc(socket, "cp.create", {
      cpId: "CP-RECONCILE-FAIL",
      wsUrl: csmsUrl(),
      connectors: 1,
      idTagPool: { file },
    });

    await waitFor(() => events.length > 0, "the reconcile to report a failure");
    expect(events[0]?.outcome).toBe("rejected");
    // Persist-first, so the live pool is untouched — the rejection is true.
    expect(server.registry.get("CP-RECONCILE-FAIL")?.getInit().idTags).toEqual([
      "BEFORE",
    ]);

    // The same bytes again must be judged afresh rather than discarded as
    // unchanged; without clearing the baseline this produces nothing at all.
    backend.save(file, JSON.stringify(["AFTER"]));
    await waitFor(
      () => events.length > 1,
      "the same bytes to be re-judged after the failed reconcile",
    );
  });
});

describe("a watch row does not depend on --watch to be cleaned up (#314)", () => {
  it("remove_scenario and definitions.replace drop their rows with no watcher", async () => {
    // Both cleanups used to sit behind `fileReload`. On a daemon running
    // without `--watch` the rows survived, and a later watched restart
    // reattached files the operator had already replaced or deleted.
    const dir = tempDir();
    const removed = writeFile(dir, "a.json", scenario("row-removed", 11));
    const replaced = writeFile(dir, "b.json", scenario("row-replaced", 12));
    const dbPath = path.join(dir, "state.sqlite");

    const db = BunSqliteDatabase.open(dbPath);
    databases.push(db);
    const watching = await startWatchingServer(new TestWatchBackend(), db);
    const firstSocket = await openClient(watching);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-ROWS",
      wsUrl: csmsUrl(),
      connectors: 2,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file: removed },
      "CP-ROWS",
    );
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 2, file: replaced },
      "CP-ROWS",
    );
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(2);
    firstSocket.disconnect();
    await watching.close();
    servers.pop();

    // Restarted WITHOUT --watch.
    const plain = await startTestServer({ database: db });
    servers.push(plain);
    const socket = await openClient(plain);
    expect(plain.fileReload).toBeNull();
    await rpc(
      socket,
      "remove_scenario",
      { connector: 1, scenarioId: "row-removed" },
      "CP-ROWS",
    );
    await rpc(socket, "scenario.definitions.replace", {
      cpId: "CP-ROWS",
      connectorId: 2,
      definitions: [JSON.parse(scenario("row-replaced", 99))],
    });

    // Both rows gone, with nothing watching anything.
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(0);
  });

  it("an inline replacement without --watch does not leave the file live", async () => {
    // The row is a fact about stored state. Cleaned up only behind the flag, a
    // daemon restarted without `--watch` left it for a later watched restart to
    // reattach — overwriting the definition installed in between.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("flagless", 11));
    const dbPath = path.join(dir, "state.sqlite");

    const firstDb = BunSqliteDatabase.open(dbPath);
    databases.push(firstDb);
    const first = await startWatchingServer(new TestWatchBackend(), firstDb);
    const firstSocket = await openClient(first);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-FLAGLESS",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file },
      "CP-FLAGLESS",
    );
    expect(firstDb.all("SELECT path FROM watched_scenario_files")).toHaveLength(
      1,
    );
    firstSocket.disconnect();
    await first.close();
    servers.pop();

    // Restarted WITHOUT --watch; the operator replaces the scenario by hand.
    const plain = await startTestServer({ database: firstDb });
    servers.push(plain);
    const plainSocket = await openClient(plain);
    expect(plain.fileReload).toBeNull();
    await rpc(plainSocket, "cp.create", {
      cpId: "CP-FLAGLESS",
      wsUrl: csmsUrl(),
      connectors: 1,
    }).catch(() => undefined);
    await rpc(
      plainSocket,
      "load_scenario",
      { connector: 1, scenario: JSON.parse(scenario("flagless", 33)) },
      "CP-FLAGLESS",
    );
    // The row is gone even though nothing was watching.
    expect(firstDb.all("SELECT path FROM watched_scenario_files")).toHaveLength(
      0,
    );
    plainSocket.disconnect();
    await plain.close();
    servers.pop();

    // A later watched restart must not reattach the abandoned file.
    const backend = new TestWatchBackend();
    const third = await startWatchingServer(backend, firstDb);
    expect(third.fileReload?.watchedPaths()).toEqual([]);
    backend.save(file, scenario("flagless", 44));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(loadedDelay(third, "CP-FLAGLESS", "flagless")).toBe(33);
  });
});

describe("a drain never runs in its caller's stack (#314)", () => {
  it("does not apply a held reload from inside the registry mutation that released it", async () => {
    // `syncFromRegistry` is the second drain trigger, and it is driven by
    // `onInitChange`, which `CPRegistry` fires *synchronously* from
    // `instantiate()`, the tail of `update()`, `remove()` and `shutdownAll()`.
    // A drain calls `loadScenario`, which can auto-start a run that snapshots
    // connector state — the same hazard the settled hook's microtask exists to
    // prevent, reached through the other channel. So the release lands after
    // the mutation returns, never inside it.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("stack", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await createConnectedCp(server, socket, "CP-STACK");
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-STACK");

    const before = server.registry.get("CP-STACK");
    if (!before) throw new Error("CP-STACK missing");
    expect(await openSession(server, "CP-STACK", "TAG-ST")).toBe("TAG-ST");
    backend.save(file, scenario("stack", 22));
    await waitFor(
      () => events.some((e) => e.outcome === "deferred"),
      "the edit to be held for the open session",
    );

    // The rebuild ends the session and pings `onInitChange` twice, the second
    // time with the scenarios back — so this is the call that releases the
    // held definition. It must not have released it by the time it returns.
    const init = before.getInit();
    server.registry.update(init);
    expect(loadedDelay(server, "CP-STACK", "stack")).toBe(11);

    await waitFor(
      () => loadedDelay(server, "CP-STACK", "stack") === 22,
      "the held reload to land on a later turn",
    );
  });
});

describe("the envelope bound is checked against the whole snapshot (#314)", () => {
  it("refuses an edit a sibling scenario would push over the size cap", async () => {
    // The reloaded file is well inside 256 KiB; the *push* is not.
    // `scenario-definitions-changed` carries every definition on the connector,
    // so validating only the edited one leaves the same failure one door along:
    // the reload lands, is reported `applied`, and the push that would tell the
    // editor about it throws and is swallowed.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("small", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-SIBLING",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-SIBLING");

    // Loaded on the service directly, because the RPC caps a single definition
    // at the same bound — a connector only reaches this state from inside, out
    // of a template fan-out or a definition that grew after it was loaded.
    const service = server.registry.get("CP-SIBLING");
    if (!service) throw new Error("CP-SIBLING missing");
    const sibling = JSON.parse(scenario("sibling-big", 1)) as {
      description?: string;
    };
    sibling.description = "x".repeat(300_000);
    service.loadScenario(1, sibling as unknown as ScenarioDefinition);

    backend.save(file, scenario("small", 22));
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.error).toContain("sibling-big");
    expect(loadedDelay(server, "CP-SIBLING", "small")).toBe(11);

    // Drop the sibling and the very same edit goes through — proof the refusal
    // was about the snapshot, not about the file.
    await rpc(
      socket,
      "remove_scenario",
      { connector: 1, scenarioId: "sibling-big" },
      "CP-SIBLING",
    );
    backend.save(file, scenario("small", 33));
    await waitFor(
      () => events.some((e) => e.outcome === "applied"),
      "the edit to land once the oversized sibling is gone",
    );
    expect(loadedDelay(server, "CP-SIBLING", "small")).toBe(33);
  });

  it("refuses an edit when the connector holds more scenarios than fit", async () => {
    // The other half of the same envelope: `definitions` is capped at
    // ARRAY_MAX_ITEMS entries. A per-definition size check says nothing about
    // how many of them there are.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("crowded", 11));
    const backend = new TestWatchBackend();
    const server = await startWatchingServer(backend);
    const socket = await openClient(server);
    const events = collectReloadEvents(socket);
    await rpc(socket, "events.subscribe", { scope: "file-reload" });
    await rpc(socket, "cp.create", {
      cpId: "CP-CROWDED",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(socket, "load_scenario", { connector: 1, file }, "CP-CROWDED");

    const service = server.registry.get("CP-CROWDED");
    if (!service) throw new Error("CP-CROWDED missing");
    // One past the cap counting the watched scenario itself.
    for (let i = 0; i < ARRAY_MAX_ITEMS; i += 1) {
      service.loadScenario(
        1,
        JSON.parse(scenario(`filler-${i}`, 1)) as ScenarioDefinition,
      );
    }

    backend.save(file, scenario("crowded", 22));
    await waitFor(() => events.length > 0, "a rejection event");
    expect(events[0]?.outcome).toBe("rejected");
    expect(events[0]?.error).toContain(`${ARRAY_MAX_ITEMS}`);
    expect(loadedDelay(server, "CP-CROWDED", "crowded")).toBe(11);
  });
});

describe("watch rows are simulator state, not watcher state (#314)", () => {
  it("cp.delete drops them on a daemon started without --watch", async () => {
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("doomed", 11));
    const db = BunSqliteDatabase.open(path.join(dir, "state.sqlite"));
    databases.push(db);

    const watching = await startWatchingServer(new TestWatchBackend(), db);
    const firstSocket = await openClient(watching);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-DOOMED",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file },
      "CP-DOOMED",
    );
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(1);
    firstSocket.disconnect();
    await watching.close();
    servers.pop();

    // Restarted without the flag; the operator deletes the charge point. The
    // row used to survive, so re-creating the same cpId later under `--watch`
    // reattached a file that charge point was never loaded from.
    const plain = await startTestServer({ database: db });
    servers.push(plain);
    const socket = await openClient(plain);
    expect(plain.fileReload).toBeNull();
    await rpc(socket, "cp.delete", { cpId: "CP-DOOMED" });
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(0);
  });

  it("state.reset truncates them, including rows no live CP owns", async () => {
    // `state.reset` promises to truncate every simulator-owned table. The
    // discriminating row is an orphan: reset removes the live charge points
    // first, and `cp.delete`'s cascade would clear anything they still owned.
    const dir = tempDir();
    const file = writeFile(dir, "s.json", scenario("kept", 11));
    const db = BunSqliteDatabase.open(path.join(dir, "state.sqlite"));
    databases.push(db);

    const watching = await startWatchingServer(new TestWatchBackend(), db);
    const firstSocket = await openClient(watching);
    await rpc(firstSocket, "cp.create", {
      cpId: "CP-RESETME",
      wsUrl: csmsUrl(),
      connectors: 1,
    });
    await rpc(
      firstSocket,
      "load_scenario",
      { connector: 1, file },
      "CP-RESETME",
    );
    firstSocket.disconnect();
    await watching.close();
    servers.pop();

    // Left behind by an earlier run whose charge point is long gone.
    rememberWatchedScenarioFile(db, "CP-VANISHED", 1, "ghost", file);
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(2);

    const plain = await startTestServer({ database: db });
    servers.push(plain);
    const socket = await openClient(plain);
    expect(plain.fileReload).toBeNull();
    await rpc(socket, "state.reset", {});
    expect(db.all("SELECT path FROM watched_scenario_files")).toHaveLength(0);
  });
});

/** The `delaySeconds` of the loaded definition's delay node. */
function loadedDelaySeconds(
  server: TestServer,
  cpId: string,
  scenarioId: string,
): number | null {
  const definition = server.registry.get(cpId)?.getScenario(1, scenarioId);
  const node = definition?.nodes.find((n) => n.type === "delay") as
    { data?: { delaySeconds?: number } } | undefined;
  return node?.data?.delaySeconds ?? null;
}

/** The `duration` of the loaded definition's single delay node. */
function loadedDelay(
  server: TestServer,
  cpId: string,
  scenarioId: string,
): number | null {
  const definition = server.registry.get(cpId)?.getScenario(1, scenarioId);
  const node = definition?.nodes[0] as { data?: { duration?: number } };
  return node?.data?.duration ?? null;
}
