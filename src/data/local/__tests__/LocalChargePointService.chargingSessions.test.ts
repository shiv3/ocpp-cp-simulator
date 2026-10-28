import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import type { ChargingSession } from "../../../cp/domain/session/ChargingSession";
import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "../LocalChargePointService";

// #447: browser mode records the charge point's sessions itself; there is no
// daemon, but the recorder and the model are the same.
const DEFINITION = {
  id: "CP-LOCAL",
  connectorNumber: 1,
  bootNotification: DefaultBootNotification,
  wsUrl: "ws://localhost:9000/ocpp/",
  basicAuth: null,
  autoMeterValueSetting: null,
  ocppVersion: "OCPP-1.6J",
};

describe("LocalChargePointService charging sessions", () => {
  let service: LocalChargePointService;

  afterEach(async () => {
    await service.syncLocalChargePoints([]).catch(() => undefined);
  });

  it("records a session and pushes each change to subscribers", async () => {
    service = new LocalChargePointService(null, createStore());
    await service.syncLocalChargePoints([DEFINITION]);
    const pushed: ChargingSession[] = [];
    service.subscribe("CP-LOCAL", (event) => {
      if (event.type === "charging-session") pushed.push(event.session);
    });
    const cp = service.getLocalChargePoint("CP-LOCAL") as ChargePoint;
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

    await cp.startTransaction("TAG-LOCAL", 1);
    cp.stopTransaction(1, "Remote");

    const page = await service.listChargingSessions("CP-LOCAL");
    expect(page.total).toBe(1);
    expect(page.sessions[0]).toMatchObject({
      cpId: "CP-LOCAL",
      idTag: "TAG-LOCAL",
      stopReason: "Remote",
      outcome: "completed",
    });
    expect(pushed.map((s) => s.outcome)).toEqual(["active", "completed"]);
    expect(pushed.at(-1)).toEqual(page.sessions[0]);
  });

  it("drops the history on resetAllState", async () => {
    service = new LocalChargePointService(null, createStore());
    await service.syncLocalChargePoints([DEFINITION]);
    const cp = service.getLocalChargePoint("CP-LOCAL") as ChargePoint;
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    await cp.startTransaction("TAG-LOCAL", 1);
    expect((await service.listChargingSessions("CP-LOCAL")).total).toBe(1);

    await service.resetAllState();

    expect((await service.listChargingSessions("CP-LOCAL")).total).toBe(0);
  });

  it("answers an empty page for an unknown charge point", async () => {
    service = new LocalChargePointService(null, createStore());

    await expect(service.listChargingSessions("missing")).resolves.toEqual({
      sessions: [],
      total: 0,
    });
  });
});
