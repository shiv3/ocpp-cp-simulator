import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyReportRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import { isValidNotifyReportRequestV201 } from "@ocpp-cp-simulator/ocpp/v201/index";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import { DEVICE_MODEL } from "../../../../domain/device-model/DeviceModelRegistry";
import { DEVICE_DATA_CTRLR_KEYS } from "../../../../domain/device-model/deviceDataCtrlrKeys";
import type { Logger } from "../../../../shared/Logger";
import { handleGetBaseReportV201 } from "../inboundRegistryV201";
import { splitIntoSizedParts } from "../reportParts";

/**
 * #605: the report bases (B07.FR.07-FR.09) and the NotifyReport parts
 * (B07.FR.04/FR.10, B08.FR.04/FR.05). The 2.1 registry reuses the 2.0.1
 * handler, so both versions run it.
 */
describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s GetBaseReport", (ocppVersion) => {
  const stations: ChargePoint[] = [];
  afterEach(() => {
    for (const station of stations.splice(0)) station.dispose();
  });

  function run(
    reportBase: string,
    limits: { items?: number; bytes?: number } = {},
  ) {
    const cp = makeChargePoint({ ocppVersion, connectorCount: 2 });
    stations.push(cp);
    if (limits.items !== undefined) {
      cp.configuration.defineRuntimeIntegerKey(
        DEVICE_DATA_CTRLR_KEYS.itemsPerGetReport,
        limits.items,
        { min: 1 },
      );
    }
    if (limits.bytes !== undefined) {
      cp.configuration.defineRuntimeIntegerKey(
        DEVICE_DATA_CTRLR_KEYS.bytesPerGetReport,
        limits.bytes,
        { min: 1 },
      );
    }
    const sendCall = vi.fn();
    const result = handleGetBaseReportV201(
      { requestId: 7, reportBase },
      { chargePoint: cp, logger: {} as Logger, sendCall },
    );
    result.afterResult?.();
    const parts = sendCall.mock.calls.map((c) => {
      expect(c[0]).toBe("NotifyReport");
      return c[1] as NotifyReportRequestV201;
    });
    const ids = (parts: NotifyReportRequestV201[]) =>
      parts.flatMap((p) =>
        (p.reportData ?? []).map(
          (rd) =>
            `${rd.component.name}${rd.component.evse ? `/${rd.component.evse.id}` : ""}.${rd.variable.name}${rd.variable.instance ? `[${rd.variable.instance}]` : ""}`,
        ),
      );
    return {
      status: (result.response as { status: string }).status,
      parts,
      ids: ids(parts),
    };
  }

  it("FullInventory reports every registry entry (every EVSE for the scoped ones)", () => {
    const { status, parts, ids } = run("FullInventory");
    expect(status).toBe("Accepted");
    expect(parts).toHaveLength(1);
    expect(isValidNotifyReportRequestV201(parts[0])).toBe(true);
    for (const def of DEVICE_MODEL.variables) {
      const id = (evse?: number) =>
        `${def.component}${evse ? `/${evse}` : ""}.${def.variable}${def.instance ? `[${def.instance}]` : ""}`;
      if (DEVICE_MODEL.isEvseScoped(def.component)) {
        expect(ids).toContain(id(1));
        expect(ids).toContain(id(2));
      } else {
        expect(ids).toContain(id());
      }
    }
  });

  it("ConfigurationInventory reports only what the operator can set", () => {
    const { parts, ids } = run("ConfigurationInventory");
    const writable = parts
      .flatMap((p) => p.reportData ?? [])
      .every((rd) =>
        rd.variableAttribute.some((a) => a.mutability !== "ReadOnly"),
      );
    expect(writable).toBe(true);
    expect(ids).toContain("OCPPCommCtrlr.HeartbeatInterval");
    expect(ids).toContain("TxCtrlr.TxStartPoint");
    expect(ids).not.toContain("ChargingStation.AvailabilityState");
    expect(ids.length).toBeLessThan(run("FullInventory").ids.length);
  });

  it("SummaryInventory reports availability of the station and each EVSE", () => {
    const { parts, ids } = run("SummaryInventory");
    expect(isValidNotifyReportRequestV201(parts[0])).toBe(true);
    // The connector of an EVSE has the EVSE's state here, so it is left out.
    expect(ids).toEqual([
      "ChargingStation.AvailabilityState",
      "EVSE/1.AvailabilityState",
      "EVSE/2.AvailabilityState",
    ]);
  });

  it("splits by ItemsPerMessage with seqNo from 0, tbc on all but the last", () => {
    const whole = run("FullInventory");
    const { parts, ids } = run("FullInventory", { items: 5 });
    expect(ids).toEqual(whole.ids);
    expect(parts.length).toBe(Math.ceil(whole.ids.length / 5));
    expect(parts.map((p) => p.seqNo)).toEqual(parts.map((_, i) => i));
    expect(parts.map((p) => p.tbc)).toEqual(
      parts.map((_, i) => i < parts.length - 1),
    );
    expect(new Set(parts.map((p) => p.requestId))).toEqual(new Set([7]));
    expect(parts.every((p) => (p.reportData?.length ?? 0) <= 5)).toBe(true);
    expect(parts.every((p) => isValidNotifyReportRequestV201(p))).toBe(true);
  });

  it("splits by BytesPerMessage so no frame exceeds it", () => {
    const limit = 3000;
    const { parts } = run("FullInventory", { bytes: limit });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const frame = JSON.stringify([
        2,
        "00000000-0000-0000-0000-000000000000",
        "NotifyReport",
        p,
      ]);
      expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(limit);
    }
  });
});

describe("splitIntoSizedParts", () => {
  const size = (items: readonly string[]) =>
    items.reduce((n, i) => n + i.length, 0);

  it("keeps one part exactly at the limits and splits one over", () => {
    const items = ["aa", "bb", "cc"] as [string, ...string[]];
    expect(splitIntoSizedParts(items, 3, 6, size)).toHaveLength(1);
    expect(
      splitIntoSizedParts(items, 2, 100, size).map((p) => p.items),
    ).toEqual([["aa", "bb"], ["cc"]]);
    expect(splitIntoSizedParts(items, 3, 5, size).map((p) => p.items)).toEqual([
      ["aa", "bb"],
      ["cc"],
    ]);
  });

  it("sends an item larger than the byte limit alone", () => {
    const parts = splitIntoSizedParts(["a", "bbbbbbbb", "c"], 10, 4, size);
    expect(parts.map((p) => p.items)).toEqual([["a"], ["bbbbbbbb"], ["c"]]);
    expect(parts.map((p) => [p.seqNo, p.tbc])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
  });

  it("rejects a non-positive item limit", () => {
    expect(() => splitIntoSizedParts(["a"], 0, 10, size)).toThrow(RangeError);
  });
});
