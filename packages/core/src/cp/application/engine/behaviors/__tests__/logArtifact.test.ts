import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { LogLevel, LogType } from "../../../../shared/Logger";
import { buildLogArtifact } from "../logArtifact";

const entry = (iso: string, message: string) => ({
  timestamp: new Date(iso),
  level: LogLevel.INFO,
  type: LogType.OCPP,
  message,
});
const cp = (entries: ReturnType<typeof entry>[]) =>
  ({ logger: { getLogEntries: () => entries } }) as unknown as ChargePoint;

describe("buildLogArtifact (#926)", () => {
  const entries = [
    entry("2026-11-08T10:00:00Z", "early"),
    entry("2026-11-08T11:00:00Z", "inside"),
    entry("2026-11-08T12:00:00Z", "late"),
  ];

  it("writes one JSON object per line with the requested window", async () => {
    const a = buildLogArtifact(cp(entries), "f.jsonl", {
      oldestTimestamp: "2026-11-08T10:30:00Z",
      latestTimestamp: "2026-11-08T11:30:00Z",
    });
    expect(a.entries).toBe(1);
    expect(a.file.name).toBe("f.jsonl");
    expect(JSON.parse((await a.file.text()).trim())).toEqual({
      timestamp: "2026-11-08T11:00:00.000Z",
      level: "INFO",
      type: "OCPP",
      message: "inside",
    });
  });

  it("keeps the newest entries within the size bound and says what it dropped", async () => {
    const a = buildLogArtifact(cp(entries), "f.jsonl", {}, 230);
    expect(a.truncated).toBe(1);
    const lines = (await a.file.text()).trim().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ truncated: 1 });
    expect(lines.map((l) => JSON.parse(l).message).slice(1)).toEqual([
      "inside",
      "late",
    ]);
  });

  it("redacts secrets in messages", async () => {
    const a = buildLogArtifact(
      cp([entry("2026-11-08T10:00:00Z", "authorizationKey=hunter2hunter2")]),
      "f.jsonl",
      {},
    );
    expect(await a.file.text()).not.toContain("hunter2hunter2");
  });
});
