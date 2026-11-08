import { describe, expect, it } from "vitest";

import { linesBetween } from "../diagnostics";

describe("linesBetween (GetDiagnostics startTime / stopTime)", () => {
  const lines = [
    "[2026-11-08T10:00:00.000Z] [INFO] [OCPP] early",
    "[2026-11-08T11:00:00.000Z] [INFO] [OCPP] inside",
    "continuation without a timestamp",
    "[2026-11-08T12:00:00.000Z] [INFO] [OCPP] late",
  ];

  it("keeps everything without a window", () => {
    expect(linesBetween(lines)).toEqual(lines);
    expect(linesBetween(lines, "not a time", undefined)).toEqual(lines);
  });

  it("limits the lines to startTime..stopTime and keeps untimed lines", () => {
    expect(
      linesBetween(lines, "2026-11-08T10:30:00Z", "2026-11-08T11:30:00Z"),
    ).toEqual([lines[1], lines[2]]);
    expect(linesBetween(lines, "2026-11-08T11:30:00Z")).toEqual([
      lines[2],
      lines[3],
    ]);
    expect(linesBetween(lines, undefined, "2026-11-08T10:30:00Z")).toEqual([
      lines[0],
      lines[2],
    ]);
  });
});
