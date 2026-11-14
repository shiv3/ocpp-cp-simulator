import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetReportRequestV201,
  NotifyReportRequestV201,
} from "@ocpp-cp-simulator/ocpp/index";
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
      componentCriteria?: GetReportRequestV201["componentCriteria"],
    ) {
      const cp = makeChargePoint({ ocppVersion, connectorCount: 2 });
      stations.push(cp);
      const sendCall = vi.fn();
      const result = handleGetReportV201(
        { requestId: 1, componentVariable, componentCriteria },
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

    it("matches the variable instance when the filter gives one (B08.FR.21)", () => {
      const itemsPerMessage = (instance?: string) =>
        report([
          {
            component: { name: "MonitoringCtrlr" },
            variable: { name: "ItemsPerMessage", instance },
          },
        ]);
      expect(itemsPerMessage().rows).toHaveLength(2);
      expect(itemsPerMessage("ClearVariableMonitoring").rows).toEqual([
        ["MonitoringCtrlr", undefined, undefined, "ItemsPerMessage"],
      ]);
      expect(itemsPerMessage("GetReport").status).toBe("EmptyResultSet");
    });

    it("matches the component instance when the filter gives one (B08.FR.22-FR.24)", () => {
      expect(
        report([{ component: { name: "MonitoringCtrlr", instance: "Main" } }])
          .status,
      ).toBe("EmptyResultSet");
    });

    it("keeps every EVSE when the filter names none", () => {
      const evses = new Set(
        report([{ component: { name: "EVSE" } }]).rows.map(([, id]) => id),
      );
      expect(evses).toEqual(new Set([1, 2]));
    });

    describe("componentCriteria (B08.FR.05, FR.07-FR.10, FR.13, FR.15)", () => {
      const components = (rows: unknown[][]) => new Set(rows.map((r) => r[0]));

      it("answers EmptyResultSet for Problem when no Problem variable is set", () => {
        const { status, rows } = report(undefined, ["Problem"]);
        expect(status).toBe("EmptyResultSet");
        expect(rows).toEqual([]);
      });

      it("keeps components without the variable and leaves out a false Enabled", () => {
        const all = report(undefined);
        const { status, rows } = report(undefined, ["Enabled"]);
        expect(status).toBe("Accepted");
        const kept = components(rows);
        // AuthCacheCtrlr.Enabled is false by default; LocalAuthListCtrlr's is true.
        expect(kept.has("AuthCacheCtrlr")).toBe(false);
        expect(kept.has("LocalAuthListCtrlr")).toBe(true);
        expect(kept.has("OCPPCommCtrlr")).toBe(true);
        expect(rows.length).toBeLessThan(all.rows.length);
      });

      it("reports a component again once its Enabled turns true", () => {
        const cp = makeChargePoint({ ocppVersion, connectorCount: 1 });
        stations.push(cp);
        cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
        const sendCall = vi.fn();
        const result = handleGetReportV201(
          { requestId: 1, componentCriteria: ["Enabled"] },
          { chargePoint: cp, logger: {} as Logger, sendCall },
        );
        result.afterResult?.();
        const names = new Set(
          (
            sendCall.mock.calls[0]?.[1] as NotifyReportRequestV201
          ).reportData?.map((rd) => rd.component.name),
        );
        expect(names.has("AuthCacheCtrlr")).toBe(true);
      });

      it("treats Active and Available as true for components without them", () => {
        const all = report(undefined);
        expect(report(undefined, ["Active"]).rows).toEqual(all.rows);
        expect(report(undefined, ["Available"]).rows).toEqual(all.rows);
      });

      it("ORs several criteria", () => {
        const enabled = report(undefined, ["Enabled"]);
        expect(report(undefined, ["Problem", "Enabled"]).rows).toEqual(
          enabled.rows,
        );
        expect(report(undefined, ["Enabled", "Active"]).rows).toEqual(
          report(undefined).rows,
        );
      });

      it("ANDs the criteria with componentVariable", () => {
        const { rows } = report(
          [{ component: { name: "AuthCacheCtrlr" } }],
          ["Enabled"],
        );
        expect(rows).toEqual([]);
        const kept = report(
          [{ component: { name: "LocalAuthListCtrlr" } }],
          ["Enabled"],
        );
        expect(components(kept.rows)).toEqual(new Set(["LocalAuthListCtrlr"]));
      });
    });
  },
);
