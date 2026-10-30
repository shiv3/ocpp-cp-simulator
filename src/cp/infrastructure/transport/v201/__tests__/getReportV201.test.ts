import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetReportRequestV201,
  NotifyReportRequestV201,
} from "../../../../../ocpp";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import type { Logger } from "../../../../shared/Logger";
import { handleGetReportV201 } from "../inboundRegistryV201";

/**
 * #538, B08.FR.11: a GetReport `componentVariable` naming an EVSE (and a
 * connector) reports that EVSE's variables only. The 2.1 registry reuses
 * the 2.0.1 handler, so both versions run it.
 */
describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s GetReport component filter",
  (ocppVersion) => {
    const stations: ChargePoint[] = [];

    afterEach(() => {
      for (const station of stations.splice(0)) station.dispose();
    });

    function report(
      componentVariable: GetReportRequestV201["componentVariable"],
    ) {
      const cp = makeChargePoint({ ocppVersion, connectorCount: 2 });
      stations.push(cp);
      const sendCall = vi.fn();
      const result = handleGetReportV201(
        { requestId: 1, componentVariable },
        { chargePoint: cp, logger: {} as Logger, sendCall },
      );
      result.afterResult?.();
      const payload = sendCall.mock.calls[0]?.[1] as
        NotifyReportRequestV201 | undefined;
      return {
        status: (result.response as { status: string }).status,
        rows: (payload?.reportData ?? []).map((rd) => [
          rd.component.name,
          rd.component.evse?.id,
          rd.component.evse?.connectorId,
          rd.variable.name,
        ]),
      };
    }

    it("reports only the EVSE the filter names", () => {
      const { status, rows } = report([
        { component: { name: "EVSE", evse: { id: 1 } } },
      ]);
      expect(status).toBe("Accepted");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(([, evseId]) => evseId === 1)).toBe(true);
    });

    it("matches the connector id when the filter gives one", () => {
      expect(
        report([
          {
            component: { name: "Connector", evse: { id: 2, connectorId: 1 } },
          },
        ]).rows,
      ).toEqual([["Connector", 2, 1, "AvailabilityState"]]);
      expect(
        report([
          {
            component: { name: "Connector", evse: { id: 2, connectorId: 2 } },
          },
        ]).status,
      ).toBe("EmptyResultSet");
    });

    it("keeps every EVSE when the filter names none", () => {
      const evses = new Set(
        report([{ component: { name: "EVSE" } }]).rows.map(([, id]) => id),
      );
      expect(evses).toEqual(new Set([1, 2]));
    });
  },
);
