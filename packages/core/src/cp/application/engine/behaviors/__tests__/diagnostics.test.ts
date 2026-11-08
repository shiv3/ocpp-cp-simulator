import { describe, expect, it, vi } from "vitest";

import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { diagnosticsBehavior, linesBetween } from "../diagnostics";

describe("diagnosticsBehavior upload (#575)", () => {
  it("uploads through the charge point's file uploader", async () => {
    const fileUploader = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const cp = {
      logger: { info: vi.fn(), warn: vi.fn(), getLogs: () => ["a line"] },
      fileUploader,
    } as unknown as ChargePoint;
    const statuses: string[] = [];
    const ctx = {
      notify: { diagnosticsStatus: (s: string) => statuses.push(s) },
      until: <T>(p: Promise<T>) => p,
      sleep: () => Promise.resolve(),
      stopping: false,
    };
    const handle = diagnosticsBehavior(cp).onCall!.GetDiagnostics!.handle as (
      request: unknown,
      ctx: unknown,
    ) => { after: () => Promise<void> };
    const result = handle({ location: "http://upload.test/diag" }, ctx);
    await result.after();
    expect(fileUploader).toHaveBeenCalledTimes(1);
    expect(fileUploader).toHaveBeenCalledWith(
      "http://upload.test/diag",
      expect.any(File),
      expect.any(AbortSignal),
    );
    expect(statuses).toEqual(["Uploading", "Uploaded"]);
  });
});

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
