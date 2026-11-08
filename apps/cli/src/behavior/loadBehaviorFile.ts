import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { readBehaviorFile } from "./readBehaviorFile";

/**
 * Bundle `file` for this process and import it. The code runs with the full
 * authority of the process: only the operator's own command line gets here
 * (`--behavior`), never a socket, MCP or OCPP message.
 */
export async function loadBehaviorFile(file: string): Promise<Behavior[]> {
  return (await readBehaviorFile(file)).behaviors;
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
