// The argument checks of scripts/record-behavior.ts (#871): a bad value is
// refused with exit code 2 before anything runs, never passed on as NaN or as
// an unknown wire version.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "record-behavior.ts");

function record(...args: string[]): { code: number; stderr: string } {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      SCRIPT,
      "default.firmware",
      "--action",
      "UpdateFirmware",
      ...args,
    ],
    // A refused argument exits at once; the bound only stops a run that was
    // not refused from hanging the suite.
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

describe("record-behavior.ts arguments", () => {
  it.each([
    [["--version", "1.5"], "--version"],
    [["--version", "2.0"], "--version"],
    [["--horizon", "abc"], "--horizon"],
    [["--horizon", "0"], "--horizon"],
    [["--step", "fast"], "--step"],
    [["--step=-250"], "--step"],
  ])("refuses %j with exit 2", (args, flag) => {
    const { code, stderr } = record(...args);
    expect(code).toBe(2);
    expect(stderr).toContain(flag);
  });
});
