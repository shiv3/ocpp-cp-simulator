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

  // The energy register is an integer watt-hour on the wire in all three of
  // these — `meterStart`, `meterStop` and the
  // `Energy.Active.Import.Register` sample. A strict CSMS rejects a
  // fractional `meterStop` with a FormationViolation that strands the
  // transaction in Charging, so the rounding lives here, at the boundary, and
  // the interpreter keeps the unrounded value: a per-tick increment smaller
  // than the register can express then accumulates instead of being discarded,
  // which is the same carry the daemon's meter scheduler performs (#301).
  startTransaction(connectorId, tagId, meterWh, nowIso): WireCall {
    return call("StartTransaction", {
      connectorId,
      idTag: tagId,
      meterStart: Math.round(meterWh),
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
      meterStop: Math.round(meterWh),
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
              value: String(Math.round(meterWh)),
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
