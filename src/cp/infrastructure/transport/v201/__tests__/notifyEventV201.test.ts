import { describe, expect, it } from "vitest";
import { isValidNotifyEventRequestV201 } from "../../../../../ocpp/v201";
import { isValidNotifyEventRequestV21 } from "../../../../../ocpp/v21";
import type { MonitoringEvent } from "../../../../domain/monitoring/MonitorEvaluation";
import type { VariableMonitor } from "../../../../domain/monitoring/VariableMonitor";
import { buildNotifyEventRequests } from "../notifyEventV201";

const DIALECTS = [
  { dialect: "v201", valid: isValidNotifyEventRequestV201 },
  { dialect: "v21", valid: isValidNotifyEventRequestV21 },
] as const;

const MONITOR: VariableMonitor = {
  id: 1,
  type: "UpperThreshold",
  severity: 4,
  value: 600,
  transaction: false,
  component: { name: "OCPPCommCtrlr", evse: { id: 1, connectorId: 1 } },
  variable: { name: "HeartbeatInterval" },
  valueKey: "HeartbeatInterval",
  origin: "CustomMonitor",
};

function event(
  eventId: number,
  overrides: Partial<MonitoringEvent> = {},
): MonitoringEvent {
  return {
    eventId,
    timestamp: new Date("2026-10-30T10:00:00.000Z"),
    monitor: { ...MONITOR, id: eventId },
    trigger: "Alerting",
    cleared: false,
    actualValue: "700",
    ...overrides,
  };
}

describe("buildNotifyEventRequests", () => {
  for (const { dialect, valid } of DIALECTS) {
    it(`${dialect}: one schema-valid part with the EVSE scope and the transactionId (#538)`, () => {
      const parts = buildNotifyEventRequests(
        [event(1, { transactionId: "tx-1" }), event(2)],
        dialect,
      );

      expect(parts).toHaveLength(1);
      const [part] = parts;
      expect(valid(part)).toBe(true);
      expect(part).toMatchObject({ seqNo: 0, tbc: false });
      expect(part.eventData[0]).toMatchObject({
        component: { name: "OCPPCommCtrlr", evse: { id: 1, connectorId: 1 } },
        transactionId: "tx-1",
      });
      expect(part.eventData[1]).not.toHaveProperty("transactionId");
      expect(part.eventData[0]).not.toHaveProperty("cause");
    });

    it(`${dialect}: splits a report into parts with increasing seqNo and tbc on all but the last (N07.FR.07)`, () => {
      const [first, ...rest] = [1, 2, 3, 4, 5].map((id) => event(id));
      const parts = buildNotifyEventRequests([first, ...rest], dialect, 2);

      expect(parts.every((p) => valid(p))).toBe(true);
      expect(parts.map((p) => [p.seqNo, p.tbc])).toEqual([
        [0, true],
        [1, true],
        [2, false],
      ]);
      expect(parts.map((p) => p.eventData.map((d) => d.eventId))).toEqual([
        [1, 2],
        [3, 4],
        [5],
      ]);
      // Every part belongs to the same report.
      expect(new Set(parts.map((p) => p.generatedAt)).size).toBe(1);
    });
  }
});
