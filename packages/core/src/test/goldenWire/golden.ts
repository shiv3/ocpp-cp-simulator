import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeFrames } from "./normalize";
import { Rig } from "./rig";
import type { GoldenCase } from "./cases";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures");

/** Run one case and return the normalized transcript. */
export async function recordCase(c: GoldenCase): Promise<string[]> {
  const rig = await Rig.create({ version: c.version, ...c.options });
  try {
    await c.run(rig);
    await rig.csms.settle(400);
    return normalizeFrames(rig.csms.frames);
  } finally {
    await rig.dispose();
  }
}

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, `${name}.jsonl`);
}

export function readFixture(name: string): string[] | null {
  const path = fixturePath(name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

/**
 * Fixtures are the regression oracle. They are written only when missing and
 * only with GOLDEN_RECORD=1; an existing fixture is never overwritten, so a
 * changed transcript is a failure to look at, not a file to regenerate.
 */
export function recordMissingFixture(name: string, lines: string[]): boolean {
  if (process.env.GOLDEN_RECORD !== "1") return false;
  if (existsSync(fixturePath(name))) return false;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(name), lines.join("\n") + "\n");
  return true;
}
