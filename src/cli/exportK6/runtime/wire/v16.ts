// src/cli/exportK6/runtime/wire/v16.ts
import { num, type Wire, type WireCall } from "../types";

function call(action: string, payload: Record<string, unknown>): WireCall {
  return { action, payload };
}

export const wire16: Wire = {
  subprotocol: "ocpp1.6",

  bootNotification(cpId: string): WireCall {
    return call("BootNotification", {
      chargePointVendor: "ocpp-cp-simulator",
      chargePointModel: "k6-loadtest",
      chargePointSerialNumber: cpId,
    });
  },

  heartbeat(): WireCall {
    return call("Heartbeat", {});
  },

  statusNotification(connectorId, status, extras): WireCall {
    const payload: Record<string, unknown> = {
      connectorId,
      status,
      errorCode: extras?.errorCode ?? "NoError",
    };
    if (extras?.info) payload.info = extras.info;
    if (extras?.vendorErrorCode)
      payload.vendorErrorCode = extras.vendorErrorCode;
    if (extras?.vendorId) payload.vendorId = extras.vendorId;
    return call("StatusNotification", payload);
  },

  startTransaction(connectorId, tagId, meterWh, nowIso): WireCall {
    return call("StartTransaction", {
      connectorId,
      idTag: tagId,
      meterStart: meterWh,
      timestamp: nowIso,
    });
  },

  parseStartTransactionConf(conf) {
    const idTagInfo = conf.idTagInfo as Record<string, unknown> | undefined;
    return {
      transactionId: num(conf.transactionId) ?? null,
      accepted: idTagInfo?.status === "Accepted",
    };
  },

  stopTransaction(transactionId, meterWh, nowIso, reason): WireCall {
    const payload: Record<string, unknown> = {
      transactionId,
      meterStop: meterWh,
      timestamp: nowIso,
    };
    if (reason) payload.reason = reason;
    return call("StopTransaction", payload);
  },

  meterValues(connectorId, transactionId, meterWh, nowIso): WireCall {
    const payload: Record<string, unknown> = {
      connectorId,
      meterValue: [
        {
          timestamp: nowIso,
          sampledValue: [
            {
              value: String(meterWh),
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
            },
          ],
        },
      ],
    };
    if (transactionId !== null) payload.transactionId = transactionId;
    return call("MeterValues", payload);
  },

  dataTransfer(vendorId, messageId, data): WireCall {
    const payload: Record<string, unknown> = { vendorId };
    if (messageId) payload.messageId = messageId;
    if (data !== undefined) payload.data = data;
    return call("DataTransfer", payload);
  },

  triggerActions(kind) {
    switch (kind) {
      case "remoteStart":
        return ["RemoteStartTransaction"];
      case "remoteStop":
        return ["RemoteStopTransaction"];
      case "reserveNow":
        return ["ReserveNow"];
    }
  },

  remoteStartTagId(payload) {
    return typeof payload.idTag === "string" ? payload.idTag : null;
  },
};
