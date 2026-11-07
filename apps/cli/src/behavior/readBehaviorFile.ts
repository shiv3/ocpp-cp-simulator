import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { behaviorsOfModule } from "@ocpp-cp-sim/core/cp/application/engine/behaviorModule";
import { bundleBehavior } from "./bundleBehavior";

export interface BehaviorFileContents {
  readonly behaviors: Behavior[];
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
): Promise<BehaviorFileContents> {
  const bundled = await bundleBehavior(file, { mode: "load" });
  if (!bundled.ok) {
    throw new Error(
      `Cannot load behavior ${file}:\n  ${bundled.problems.join("\n  ")}`,
    );
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ocpp-behavior-"));
  try {
    const out = path.join(dir, "behavior.mjs");
    writeFileSync(out, bundled.code);
    const mod: unknown = await import(pathToFileURL(out).href);
    return {
      behaviors: behaviorsOfModule(file, mod),
      hash: createHash("sha256").update(bundled.code).digest("hex"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
