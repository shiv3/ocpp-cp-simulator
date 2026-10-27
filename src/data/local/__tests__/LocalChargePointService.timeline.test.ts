import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "../LocalChargePointService";

// #448: browser mode reads the charge point's operational timeline directly;
// there is no daemon, and no scenario run ids, but the domain projection is
// the same.
describe("LocalChargePointService operational timeline", () => {
  let service: LocalChargePointService;

  afterEach(async () => {
    await service.syncLocalChargePoints([]).catch(() => undefined);
  });

  it("returns the charge point's timeline, filtered", async () => {
    service = new LocalChargePointService(null, createStore());
    await service.syncLocalChargePoints([
      {
        id: "CP-LOCAL",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "ws://localhost:9000/ocpp/",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.6J",
      },
    ]);
    const cp = service.getLocalChargePoint("CP-LOCAL") as ChargePoint;
    cp.updateConnectorStatus(1, OCPPStatus.Available);

    const page = await service.getOperationalTimeline("CP-LOCAL", {
      kinds: ["connector_status"],
    });

    expect(page.entries.at(-1)).toMatchObject({
      kind: "connector_status",
      cpId: "CP-LOCAL",
      connectorId: 1,
      data: { to: OCPPStatus.Available },
    });
    expect(page.total).toBe(page.entries.length);
  });

  it("pushes each new entry to subscribers", async () => {
    service = new LocalChargePointService(null, createStore());
    await service.syncLocalChargePoints([
      {
        id: "CP-LOCAL",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "ws://localhost:9000/ocpp/",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.6J",
      },
    ]);
    const pushed: unknown[] = [];
    service.subscribe("CP-LOCAL", (event) => {
      if (event.type === "timeline-entry") pushed.push(event.entry);
    });
    const cp = service.getLocalChargePoint("CP-LOCAL") as ChargePoint;

    cp.updateConnectorStatus(1, OCPPStatus.Available);

    expect(pushed).toEqual(
      (await service.getOperationalTimeline("CP-LOCAL")).entries.slice(-1),
    );
  });

  it("answers an empty page for an unknown charge point", async () => {
    service = new LocalChargePointService(null, createStore());

    await expect(service.getOperationalTimeline("missing")).resolves.toEqual({
      entries: [],
      total: 0,
    });
  });
});
