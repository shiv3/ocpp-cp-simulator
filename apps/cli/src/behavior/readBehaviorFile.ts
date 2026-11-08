import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { behaviorsOfModule } from "@ocpp-cp-sim/core/cp/application/engine/behaviorModule";
import { bundleBehavior } from "./bundleBehavior";
import { missingCapabilityProblem } from "./ctxUse";

export interface BehaviorFileContents {
  /** Empty when `unchanged`: the module was not run. */
  readonly behaviors: Behavior[];
  /** The bundle hashes to the `previousHash` the caller passed. */
  readonly unchanged?: boolean;
  /** Hash of the bundle: equal for two reads of an unchanged file and its imports. */
  readonly hash: string;
}

/**
 * Bundle `file` for this process and import it. The code runs with the full
 * authority of the process: only the operator's own command line gets here
 * (`--behavior`, `--watch-behaviors`, `behavior.reload`, which re-reads the
 * paths given at start), never a path or code from a socket, MCP or OCPP
 * message.
 *
 * Every call writes the bundle under a fresh temporary directory, so the
 * module cache of the runtime (keyed by URL) never hands back an older
 * version, and removes the directory once the module was imported.
 */
export async function readBehaviorFile(
  file: string,
  options: {
    /** When the new bundle hashes to this, the module is not run. */
    readonly previousHash?: string;
    /** How long the module's top level may take; it then counts as failed. */
    readonly timeoutMs?: number;
  } = {},
): Promise<BehaviorFileContents> {
  const bundled = await bundleBehavior(file, { mode: "load" });
  if (!bundled.ok) {
    throw new Error(
      `Cannot load behavior ${file}:\n  ${bundled.problems.join("\n  ")}`,
    );
  }
  const hash = createHash("sha256").update(bundled.code).digest("hex");
  if (hash === options.previousHash) {
    return { behaviors: [], unchanged: true, hash };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ocpp-behavior-"));
  try {
    const out = path.join(dir, "behavior.mjs");
    writeFileSync(out, bundled.code);
    const mod = await withTimeout(
      import(pathToFileURL(out).href) as Promise<unknown>,
      options.timeoutMs ?? 10_000,
      `Cannot load behavior ${file}: its top level did not finish in time (a top-level await that never settles?)`,
    );
    const behaviors = behaviorsOfModule(file, mod);
    // Refused here instead of at the first call that would fail.
    const missing = missingCapabilityProblem(file, bundled.code, behaviors);
    if (missing) throw new Error(`Cannot load behavior ${missing}`);
    return { behaviors, hash };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
