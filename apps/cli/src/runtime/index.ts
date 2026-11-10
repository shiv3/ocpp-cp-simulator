/**
 * The runtime layer (#916): the one place that decides whether the CLI runs on
 * Bun or on Node. Chosen once, when this module loads; every caller goes
 * through {@link runtime}. On Bun the behaviour is exactly what it was before
 * the layer existed (the Docker image and the Tauri sidecar run on Bun).
 */
import { bunRuntime } from "./bun";
import type { Runtime } from "./types";

export type {
  FetchHandler,
  Runtime,
  RuntimeFile,
  RuntimeServer,
  ServeOptions,
  SocketIoEngine,
  SocketIoEngineOptions,
  SpawnedProcess,
  SpawnOptions,
} from "./types";
export { isMainModule, moduleDir } from "./paths";

/** True when running on Bun (`typeof Bun !== "undefined"`). */
export const isBun: boolean =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const runtime: Runtime = bunRuntime;
