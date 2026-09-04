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
