// Side effects the engine needs before anything else is evaluated: imported
// first by `entry.ts`, so ES module order runs it ahead of core.
import { setLoggerConsole } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { installK6WebSocket } from "./k6WebSocket";
import { installPolyfills } from "./polyfills";

installPolyfills();
installK6WebSocket();
// k6 prints every console call; the station logs errors only (see charger.ts).
const quiet = (): void => undefined;
setLoggerConsole({
  debug: quiet,
  info: quiet,
  log: quiet,
  warn: quiet,
  error: (...args: unknown[]) => console.error(...args),
});
