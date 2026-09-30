import { describe, expect, it, vi } from "vitest";

import { OCPPSoapServer } from "../OCPPSoapServer";
import type { OCPPSoapServerTarget } from "../OCPPSoapServer";
import { buildSoapEnvelope, type SoapPayload } from "../soapEnvelope";
import {
  OCPP15_DIALECT,
  OCPP16_DIALECT,
  type SoapDialect,
  type SoapOperation,
} from "../dialect";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { IncomingCallCompletion } from "../../../../domain/charge-point/ChargePointEvents";
import { Logger, LogLevel } from "../../../../shared/Logger";

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
      chargePoint: {
        notifyIncomingCall,
        notifyIncomingCallCompleted: vi.fn(),
      } as unknown as ChargePoint,
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
      "uuid:reset-notify",
    );
  });

  it("does not notify when a valid-target request has no dispatch path", async () => {
    // Reset is a dispatchable (target "cp") op, but with an empty legacy
    // registry AND no logger there is no handler for it — it faults as
    // not-implemented. A csmsCallTrigger must NOT be resolved in that case.
    const notifyIncomingCall = vi.fn();
    const target: OCPPSoapServerTarget = {
      cpId: "CP",
      applyRemoteReset: vi.fn(),
      isRegisteredSoapChargePoint: () => true,
      chargePoint: { notifyIncomingCall } as unknown as ChargePoint,
      // logger intentionally omitted -> canDispatchViaRegistry is false
    };
    const server = new OCPPSoapServer(
      target,
      new Map(), // empty legacy registry -> no Reset handler
      OCPP15_DIALECT,
    );

    const xml = buildSoapEnvelope({
      operation: "Reset",
      chargeBoxIdentity: "CP",
      messageId: "uuid:reset-nodispatch",
      from: "http://csms.example/CentralSystemService",
      to: "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService",
      payload: { type: "Hard" },
      dialect: OCPP15_DIALECT,
    });

    const res = await server.handleRequest("CP", xml);
    const body = await res.text();

    expect(body).toContain("is not implemented by the SOAP ChargePointService");
    expect(notifyIncomingCall).not.toHaveBeenCalled();
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

/**
 * #396: the control plane pairs every announced SOAP call with its answer,
 * correlated by the WS-Addressing MessageID. A SOAP Fault is the CALLERROR
 * equivalent; its errorCode is the Fault code (`Sender` / `Receiver`).
 */
describe("OCPPSoapServer reports the answer to an inbound call (#396)", () => {
  function serverWith(
    order: string[],
    options: {
      dialect?: SoapDialect;
      registered?: boolean;
      logger?: Logger;
    } = {},
  ): OCPPSoapServer {
    const chargePoint = {
      notifyIncomingCall: (action: string, _p: unknown, messageId?: string) =>
        order.push(`received:${action}:${messageId}`),
      notifyIncomingCallCompleted: (c: IncomingCallCompletion) =>
        order.push(
          `completed:${c.action}:${c.messageId}:${c.outcome}${c.outcome === "CallError" ? `:${c.errorCode}` : ""}`,
        ),
      sendCurrentStatusNotification: () => order.push("effect"),
    } as unknown as ChargePoint;
    return new OCPPSoapServer(
      {
        cpId: "CP",
        applyRemoteReset: () => order.push("reset"),
        isRegisteredSoapChargePoint: () => options.registered ?? true,
        chargePoint,
        logger: options.logger,
      },
      undefined,
      options.dialect ?? OCPP15_DIALECT,
    );
  }

  const callXml = (
    operation: SoapOperation,
    messageId: string,
    payload: SoapPayload,
    dialect: SoapDialect = OCPP15_DIALECT,
  ) =>
    buildSoapEnvelope({
      operation,
      chargeBoxIdentity: "CP",
      messageId,
      from: "http://csms.example/CentralSystemService",
      to: "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService",
      payload,
      dialect,
    });

  it("completes a Reset with CallResult before its post-response effect", async () => {
    const order: string[] = [];
    const res = await serverWith(order).handleRequest(
      "CP",
      callXml("Reset", "uuid:reset-ok", { type: "Soft" }),
    );

    expect(res.status).toBe(200);
    expect(order).toEqual([
      "received:Reset:uuid:reset-ok",
      "completed:Reset:uuid:reset-ok:CallResult",
      "reset",
    ]);
  });

  it("completes a shared-handler call before that handler's deferred effect", async () => {
    // TriggerMessage goes through the v16 registry, whose handler defers
    // the StatusNotification it triggers until after the reply.
    const order: string[] = [];
    const server = serverWith(order, {
      dialect: OCPP16_DIALECT,
      logger: new Logger(LogLevel.ERROR),
    });

    const res = await server.handleRequest(
      "CP",
      callXml(
        "TriggerMessage",
        "uuid:trigger",
        { requestedMessage: "StatusNotification", connectorId: 1 },
        OCPP16_DIALECT,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(order).toEqual([
      "received:TriggerMessage:uuid:trigger",
      "completed:TriggerMessage:uuid:trigger:CallResult",
      "effect",
    ]);
  });

  it("completes with CallError when the announced call is answered with a Fault", async () => {
    const order: string[] = [];
    const res = await serverWith(order).handleRequest(
      "CP",
      callXml("Reset", "uuid:reset-bad", { type: "Sideways" }),
    );

    expect(res.status).toBe(400);
    expect(order).toEqual([
      "received:Reset:uuid:reset-bad",
      "completed:Reset:uuid:reset-bad:CallError:Sender",
    ]);
  });

  it("reports nothing for a request rejected before dispatch", async () => {
    const order: string[] = [];
    const res = await serverWith(order, { registered: false }).handleRequest(
      "CP",
      callXml("Reset", "uuid:reset-foreign", { type: "Soft" }),
    );

    expect(res.status).toBe(403);
    expect(order).toEqual([]);
  });

  it("reports nothing for a call the station cannot dispatch", async () => {
    // Unlike OCPP-J, where it completes as CallError / NotImplemented: a
    // SOAP call without a dispatch path is not announced, so it must not
    // be completed either (#257 keeps it from releasing a csmsCallTrigger).
    const order: string[] = [];
    // No logger: the shared v16 registry is unavailable, so only the legacy
    // Reset handler can answer.
    const res = await serverWith(order).handleRequest(
      "CP",
      callXml("ClearCache", "uuid:clear-cache", {}),
    );

    expect(await res.text()).toContain("is not implemented");
    expect(order).toEqual([]);
  });
});
