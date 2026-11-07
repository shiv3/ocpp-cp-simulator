import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { behaviorsOfModule } from "@ocpp-cp-sim/core/cp/application/engine/behaviorModule";
import { bundleBehavior } from "./bundleBehavior";

/**
 * Bundle `file` for this process and import it. The code runs with the full
 * authority of the process: only the operator's own command line gets here
 * (`--behavior`), never a socket, MCP or OCPP message.
 */
export async function loadBehaviorFile(file: string): Promise<Behavior[]> {
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
    return behaviorsOfModule(file, mod);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function loadBehaviorFiles(
  files: readonly string[],
): Promise<Behavior[]> {
  const all: Behavior[] = [];
  for (const file of files) all.push(...(await loadBehaviorFile(file)));
  const seen = new Set<string>();
  for (const b of all) {
    if (seen.has(b.id))
      throw new Error(`Behavior id "${b.id}" is loaded twice`);
    seen.add(b.id);
  }
  return all;
}
