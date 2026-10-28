import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { Database, SqlParam, SqlRow } from "../../persistence/Database";
import type { Transaction } from "../../connector/Transaction";

// #454: ClockAlignedDataInterval / MeterValuesAlignedData drive a
// clock-aligned scheduler — Sample.Clock samples on wall-clock boundaries.

const START = Date.parse("2026-10-28T12:00:17Z");
const ENERGY = "Energy.Active.Import.Register";

function makeCp(
  ocppVersion = "OCPP-1.6J",
  database: Database | null = null,
  connectorCount = 2,
): ChargePoint {
  return new ChargePoint(
    "cp-clock",
    DefaultBootNotification,
    connectorCount,
    "ws://localhost:8080",
    null,
    null,
    database,
    {},
    [],
    ocppVersion,
    {},
  );
}

/** Answers the configuration-override query and nothing else. */
class OverrideDatabase implements Database {
  constructor(private readonly overrides: Record<string, string>) {}
  exec(): void {}
  run(): void {}
  all<T = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    if (!sql.includes("FROM configuration")) return [];
    return Object.entries(this.overrides).map(([key, value]) => ({
      key,
      value,
    })) as T[];
  }
  get<T = SqlRow>(): T | null {
    return null;
  }
  close(): void {}
}

function spyOutbox(cp: ChargePoint) {
  const outbox = cp["_outbox"];
  return {
    meterValue: vi
      .spyOn(outbox, "sendMeterValue")
      .mockImplementation(() => undefined),
    transactionUpdate: vi
      .spyOn(outbox, "sendTransactionUpdate")
      .mockImplementation(() => undefined),
  };
}

function bootAccepted(cp: ChargePoint): void {
  cp.onBootNotificationResult({
    status: "Accepted",
    interval: 0,
    currentTime: new Date().toISOString(),
  });
}

function activeTransaction(connectorId: number, id: number): Transaction {
  return {
    id,
    connectorId,
    tagId: "TAG",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(START),
    stopTime: null,
    meterSent: false,
  };
}

function configure(cp: ChargePoint, interval: string, measurands = ENERGY) {
  expect(
    cp.configuration.applyChange("MeterValuesAlignedData", measurands),
  ).toBe("Accepted");
  expect(
    cp.configuration.applyChange("ClockAlignedDataInterval", interval),
  ).toBe("Accepted");
}

describe("ChargePoint clock-aligned meter values (#454)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to interval 0: nothing is emitted", () => {
    const cp = makeCp();
    const sent = spyOutbox(cp);
    bootAccepted(cp);
    vi.advanceTimersByTime(3_600_000);
    expect(cp.configuration.get("ClockAlignedDataInterval")?.value).toBe(0);
    expect(sent.meterValue).not.toHaveBeenCalled();
  });

  it("1.6 without a transaction: one Sample.Clock MeterValues per connector, on the boundary", () => {
    const cp = makeCp();
    const sent = spyOutbox(cp);
    configure(cp, "60");
    bootAccepted(cp);

    vi.advanceTimersByTime(42_999);
    expect(sent.meterValue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    const opts = {
      measurands: [ENERGY],
      timestamp: new Date("2026-10-28T12:01:00Z"),
    };
    expect(sent.meterValue.mock.calls).toEqual([
      [undefined, 1, "Sample.Clock", opts],
      [undefined, 2, "Sample.Clock", opts],
    ]);
    expect(sent.transactionUpdate).not.toHaveBeenCalled();
  });

  it("uses MeterValuesAlignedData, not MeterValuesSampledData", () => {
    const cp = makeCp("OCPP-1.6J", null, 1);
    const sent = spyOutbox(cp);
    cp.configuration.applyChange("MeterValuesSampledData", "Current.Import");
    configure(cp, "60", "Voltage,Power.Active.Import");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000);
    expect(sent.meterValue.mock.calls[0]![3]).toMatchObject({
      measurands: ["Voltage", "Power.Active.Import"],
    });
  });

  it("an empty MeterValuesAlignedData sends nothing", () => {
    const cp = makeCp();
    const sent = spyOutbox(cp);
    configure(cp, "60", "");
    bootAccepted(cp);
    vi.advanceTimersByTime(600_000);
    expect(sent.meterValue).not.toHaveBeenCalled();
  });

  it("1.6 with a transaction: carries its id; an unconfirmed (id 0) transaction carries none", () => {
    const cp = makeCp();
    const sent = spyOutbox(cp);
    cp.getConnector(1)!.transaction = activeTransaction(1, 42);
    cp.getConnector(2)!.transaction = activeTransaction(2, 0);
    configure(cp, "60");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000);
    expect(sent.meterValue.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [42, 1],
      [undefined, 2],
    ]);
  });

  it("1.6: a stopped transaction is not a live one", () => {
    const cp = makeCp("OCPP-1.6J", null, 1);
    const sent = spyOutbox(cp);
    cp.getConnector(1)!.transaction = {
      ...activeTransaction(1, 42),
      stopTime: new Date(START),
    };
    configure(cp, "60");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000);
    expect(sent.meterValue.mock.calls[0]![0]).toBeUndefined();
  });

  it.each(["OCPP-2.0.1", "OCPP-2.1"])(
    "%s: MeterValuesRequest when idle, TransactionEvent(Updated, MeterValueClock) during a transaction",
    (version) => {
      const cp = makeCp(version);
      const sent = spyOutbox(cp);
      cp.getConnector(2)!.transaction = activeTransaction(2, 0);
      configure(cp, "60");
      bootAccepted(cp);
      vi.advanceTimersByTime(43_000);

      const timestamp = new Date("2026-10-28T12:01:00Z");
      expect(sent.meterValue.mock.calls).toEqual([
        [undefined, 1, "Sample.Clock", { measurands: [ENERGY], timestamp }],
      ]);
      expect(sent.transactionUpdate.mock.calls).toEqual([
        [
          2,
          {
            triggerReason: "MeterValueClock",
            meterValues: true,
            context: "Sample.Clock",
            measurands: [ENERGY],
            timestamp,
          },
        ],
      ]);
    },
  );

  it("2.x: an interval set after boot starts the scheduler", () => {
    const cp = makeCp("OCPP-2.0.1", null, 1);
    const sent = spyOutbox(cp);
    bootAccepted(cp);
    const results = cp.configuration.applyChange(
      "MeterValuesAlignedData",
      ENERGY,
    );
    expect(results).toBe("Accepted");
    expect(
      cp.configuration.applyChange("ClockAlignedDataInterval", "900"),
    ).toBe("Accepted");
    vi.advanceTimersByTime(14 * 60_000 + 43_000); // 12:15:00
    expect(sent.meterValue.mock.calls.map((c) => c[3]?.timestamp)).toEqual([
      new Date("2026-10-28T12:15:00Z"),
    ]);
  });

  it("a runtime interval change reschedules; 0 disables", () => {
    const cp = makeCp("OCPP-1.6J", null, 1);
    const sent = spyOutbox(cp);
    configure(cp, "60");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000); // 12:01:00
    cp.configuration.applyChange("ClockAlignedDataInterval", "900");
    vi.advanceTimersByTime(14 * 60_000); // 12:15:00
    cp.configuration.applyChange("ClockAlignedDataInterval", "0");
    vi.advanceTimersByTime(3_600_000);
    expect(sent.meterValue.mock.calls.map((c) => c[3]?.timestamp)).toEqual([
      new Date("2026-10-28T12:01:00Z"),
      new Date("2026-10-28T12:15:00Z"),
    ]);
  });

  it("rejects a negative interval and one longer than a day", () => {
    const cp = makeCp();
    expect(cp.configuration.applyChange("ClockAlignedDataInterval", "-1")).toBe(
      "Rejected",
    );
    expect(
      cp.configuration.applyChange("ClockAlignedDataInterval", "86401"),
    ).toBe("Rejected");
  });

  it("does not run before BootNotification is accepted", () => {
    const cp = makeCp();
    const sent = spyOutbox(cp);
    configure(cp, "60");
    vi.advanceTimersByTime(600_000);
    expect(sent.meterValue).not.toHaveBeenCalled();
  });

  it("honours a persisted interval at boot", () => {
    const cp = makeCp(
      "OCPP-1.6J",
      new OverrideDatabase({
        ClockAlignedDataInterval: "60",
        MeterValuesAlignedData: JSON.stringify([ENERGY]),
      }),
      1,
    );
    const sent = spyOutbox(cp);
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000);
    expect(sent.meterValue).toHaveBeenCalledTimes(1);
  });

  it("stops on disconnect and resumes after the next accepted boot without duplicating a boundary", () => {
    const cp = makeCp("OCPP-1.6J", null, 1);
    const sent = spyOutbox(cp);
    configure(cp, "60");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000); // 12:01:00 sent
    cp.disconnect();
    vi.advanceTimersByTime(120_000); // offline across 12:02 and 12:03
    // Reconnect + boot accepted at 12:03:00 exactly — 12:03 is not re-sent
    // late, the next boundary is 12:04.
    bootAccepted(cp);
    vi.advanceTimersByTime(60_000);
    expect(sent.meterValue.mock.calls.map((c) => c[3]?.timestamp)).toEqual([
      new Date("2026-10-28T12:01:00Z"),
      new Date("2026-10-28T12:04:00Z"),
    ]);
  });

  it("a second accepted boot does not emit the same boundary twice", () => {
    const cp = makeCp("OCPP-1.6J", null, 1);
    const sent = spyOutbox(cp);
    configure(cp, "60");
    bootAccepted(cp);
    vi.advanceTimersByTime(43_000); // 12:01:00 sent
    bootAccepted(cp); // e.g. a re-boot landing on the boundary instant
    vi.advanceTimersByTime(60_000);
    expect(sent.meterValue.mock.calls.map((c) => c[3]?.timestamp)).toEqual([
      new Date("2026-10-28T12:01:00Z"),
      new Date("2026-10-28T12:02:00Z"),
    ]);
  });
});
