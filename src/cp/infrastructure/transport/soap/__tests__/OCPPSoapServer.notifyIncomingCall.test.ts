import { describe, expect, it, vi } from "vitest";

import { OCPPSoapServer } from "../OCPPSoapServer";
import type { OCPPSoapServerTarget } from "../OCPPSoapServer";
import { buildSoapEnvelope, OCPP15_DIALECT } from "../soapEnvelope";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";

/**
 * #257: the SOAP inbound server must surface every CS→CP call to the scenario
 * layer via ChargePoint.notifyIncomingCall — mirroring the JSON path — so a
 * `csmsCallTrigger` node on a SOAP charge point resolves instead of hanging.
 */
describe("OCPPSoapServer notifies the scenario layer of inbound calls (#257)", () => {
  it("calls chargePoint.notifyIncomingCall for a received CS→CP request", async () => {
    const notifyIncomingCall = vi.fn();
    const target: OCPPSoapServerTarget = {
      cpId: "CP",
      applyRemoteReset: vi.fn(),
      isRegisteredSoapChargePoint: () => true,
      chargePoint: { notifyIncomingCall } as unknown as ChargePoint,
    };
    const server = new OCPPSoapServer(target, undefined, OCPP15_DIALECT);

    const xml = buildSoapEnvelope({
      operation: "Reset",
      chargeBoxIdentity: "CP",
      messageId: "uuid:reset-notify",
      from: "http://csms.example/CentralSystemService",
      to: "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService",
      payload: { type: "Hard" },
      dialect: OCPP15_DIALECT,
    });

    const res = await server.handleRequest("CP", xml);

    expect(res.status).toBe(200);
    expect(notifyIncomingCall).toHaveBeenCalledTimes(1);
    expect(notifyIncomingCall).toHaveBeenCalledWith(
      "Reset",
      expect.objectContaining({ type: "Hard" }),
    );
  });

  it("does not notify when the request is rejected before dispatch", async () => {
    const notifyIncomingCall = vi.fn();
    const target: OCPPSoapServerTarget = {
      cpId: "CP",
      applyRemoteReset: vi.fn(),
      // Not a registered SOAP CP -> assertRequestForTarget throws first.
      isRegisteredSoapChargePoint: () => false,
      chargePoint: { notifyIncomingCall } as unknown as ChargePoint,
    };
    const server = new OCPPSoapServer(target, undefined, OCPP15_DIALECT);

    const xml = buildSoapEnvelope({
      operation: "Reset",
      chargeBoxIdentity: "CP",
      messageId: "uuid:reset-reject",
      from: "http://csms.example/CentralSystemService",
      to: "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService",
      payload: { type: "Hard" },
      dialect: OCPP15_DIALECT,
    });

    const res = await server.handleRequest("CP", xml);

    expect(res.status).toBe(403);
    expect(notifyIncomingCall).not.toHaveBeenCalled();
  });
});
