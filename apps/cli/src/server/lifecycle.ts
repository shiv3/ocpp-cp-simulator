import * as fs from "fs";
import type { Server } from "bun";
import type { CPRegistry } from "./CPRegistry";

// We don't introspect the WS data type from this module, so any concrete
// generic is fine. The route handlers narrow it where they need to.
type AnyServer = Server<unknown>;

export interface Lifecycle {
  attachServer(server: AnyServer): void;
  /** Tears everything down and exits; `exitCode` defaults to 0. */
  requestShutdown(exitCode?: number): void;
  installSignalHandlers(): void;
}

export interface LifecycleOptions {
  readonly pidPath: string | null;
  readonly registry: CPRegistry;
  readonly onShutdownStart?: () => void;
  /**
   * #622: runs first on a signal-driven or requested shutdown and is awaited
   * before anything is torn down (stop the transactions, wait for the CSMS).
   * A second shutdown request while it runs skips what is left of the wait.
   * Errors are logged and do not stop the shutdown.
   */
  readonly beforeShutdown?: (skip: Promise<void>) => Promise<void>;
}

export function createLifecycle(opts: LifecycleOptions): Lifecycle {
  const servers: AnyServer[] = [];
  let shuttingDown = false;

  if (opts.pidPath) {
    removeStalePid(opts.pidPath);
    fs.writeFileSync(opts.pidPath, String(process.pid), "utf-8");
  }

  let skipWait: (() => void) | null = null;
  const skipped = new Promise<void>((resolve) => {
    skipWait = resolve;
  });

  const requestShutdown = (exitCode = 0): void => {
    if (shuttingDown) {
      // A second SIGINT / SIGTERM while the graceful wait runs: stop waiting.
      skipWait?.();
      return;
    }
    shuttingDown = true;

    process.stderr.write("[server] Shutting down...\n");
    if (opts.beforeShutdown) {
      opts
        .beforeShutdown(skipped)
        .catch((err: unknown) => {
          process.stderr.write(
            `[server] Graceful shutdown step failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        })
        .then(() => teardown(exitCode));
      return;
    }
    teardown(exitCode);
  };

  const teardown = (exitCode: number): void => {
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

    process.exit(exitCode);
  };

  return {
    attachServer(server) {
      servers.push(server);
    },
    requestShutdown,
    installSignalHandlers() {
      // Wrapped: the listener receives the signal name, not an exit code.
      process.on("SIGINT", () => requestShutdown());
      process.on("SIGTERM", () => requestShutdown());
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
