import * as fs from "fs";
import type { Server } from "bun";
import type { CPRegistry } from "./CPRegistry";

// We don't introspect the WS data type from this module, so any concrete
// generic is fine. The route handlers narrow it where they need to.
type AnyServer = Server<unknown>;

export interface Lifecycle {
  attachServer(server: AnyServer): void;
  requestShutdown(): void;
  installSignalHandlers(): void;
}

export interface LifecycleOptions {
  readonly pidPath: string | null;
  readonly registry: CPRegistry;
  readonly onShutdownStart?: () => void;
}

export function createLifecycle(opts: LifecycleOptions): Lifecycle {
  const servers: AnyServer[] = [];
  let shuttingDown = false;

  if (opts.pidPath) {
    removeStalePid(opts.pidPath);
    fs.writeFileSync(opts.pidPath, String(process.pid), "utf-8");
  }

  const requestShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    process.stderr.write("[server] Shutting down...\n");
    opts.onShutdownStart?.();

    for (const server of servers) {
      try {
        server.stop(true);
      } catch {
        // ignore
      }
    }

    opts.registry.shutdownAll();

    if (opts.pidPath) {
      try {
        fs.unlinkSync(opts.pidPath);
      } catch {
        // ignore
      }
    }

    process.exit(0);
  };

  return {
    attachServer(server) {
      servers.push(server);
    },
    requestShutdown,
    installSignalHandlers() {
      process.on("SIGINT", requestShutdown);
      process.on("SIGTERM", requestShutdown);
    },
  };
}

function removeStalePid(pidPath: string): void {
  try {
    const pidStr = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        process.stderr.write(
          `Error: Another server is already running (PID ${pid})\n`,
        );
        process.exit(1);
      } catch {
        // process not running, safe to overwrite
      }
    }
  } catch {
    // no pid file, fine
  }
}
