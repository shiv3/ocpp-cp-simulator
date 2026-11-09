import { describe, expect, it } from "vitest";
import type { ChargerEngine } from "../ChargerEngine";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../../infrastructure/charge-point/createChargePoint";
import { Logger, LogLevel } from "../../../shared/Logger";
import { Connector } from "../../../domain/connector/Connector";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";

function station(connectors = 2): ChargePoint {
  return createChargePoint(
    "engine-connector-state",
    DefaultBootNotification,
    connectors,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

describe("connector state in the charger engine", () => {
  it("keeps status, availability and error info of every connector in engine state", () => {
    const cp = station();
    const connector = cp.getConnector(1)!;

    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    connector.availability = "Inoperative";
    connector.scheduledAvailability = "Operative";
    connector.currentErrorCode = "GroundFailure";
    connector.errorInfo = "trip";
    connector.vendorErrorCode = "V-7";

    expect(cp.engine.state.connectors["1"]).toEqual({
      status: OCPPStatus.Preparing,
      availability: "Inoperative",
      scheduledAvailability: "Operative",
      errorCode: "GroundFailure",
      errorInfo: "trip",
      vendorErrorCode: "V-7",
      transaction: null,
    });
    expect(cp.engine.state.connectors["2"].status).toBe(OCPPStatus.Unavailable);
    // The connector reads the same record back.
    expect(connector.status).toBe(OCPPStatus.Preparing);
    expect(connector.availability).toBe("Inoperative");
    expect(
      (cp.engine as ChargerEngine).snapshot().connectors["1"].vendorErrorCode,
    ).toBe("V-7");
  });

  it("emits the same events, in the same order, for each kind of write", () => {
    const cp = station(1);
    const connector = cp.getConnector(1)!;
    const seen: string[] = [];
    connector.events.on("statusChange", ({ status, previousStatus }) =>
      seen.push(`connector ${previousStatus}->${status}`),
    );
    cp.events.on("connectorStatusChange", ({ status, previousStatus }) =>
      seen.push(`cp ${previousStatus}->${status}`),
    );

    connector.status = OCPPStatus.Available; // bare write: connector only
    cp.updateConnectorStatus(1, OCPPStatus.Preparing); // both

    expect(seen).toEqual([
      "connector Unavailable->Available",
      "connector Available->Preparing",
      "cp Available->Preparing",
    ]);
  });

  it("applies a write made by a listener before the outer write returns", () => {
    const cp = station(1);
    const connector = cp.getConnector(1)!;
    const order: string[] = [];
    connector.events.on("statusChange", ({ status }) => {
      order.push(status);
      if (status === OCPPStatus.Preparing) {
        cp.updateConnectorStatus(1, OCPPStatus.Finishing);
      }
    });

    cp.updateConnectorStatus(1, OCPPStatus.Preparing);

    expect(order).toEqual([OCPPStatus.Preparing, OCPPStatus.Finishing]);
    expect(connector.status).toBe(OCPPStatus.Finishing);
  });

  it("keeps the last record of a removed connector in the connector itself", () => {
    const cp = station(2);
    cp.updateConnectorStatus(2, OCPPStatus.Faulted);
    const connector = cp.getConnector(2)!;

    expect(cp.removeConnector(2)).toBe(true);

    expect(cp.engine.state.connectors["2"]).toBeUndefined();
    expect(connector.status).toBe(OCPPStatus.Faulted);
  });

  it("only warns about a transition outside the allowed table", () => {
    const cp = station(1);
    const warnings: string[] = [];
    cp.logger.loggingCallback = (entry) => {
      if (
        entry.level === LogLevel.WARN &&
        entry.message.includes("expected transition")
      )
        warnings.push(entry.message);
    };
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    warnings.length = 0;

    cp.updateConnectorStatus(1, OCPPStatus.Finishing); // not listed after Available (A6)

    expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Finishing);
    expect(warnings).toEqual([
      expect.stringContaining("not an expected transition"),
    ]);
    warnings.length = 0;
    cp.updateConnectorStatus(1, OCPPStatus.Available); // listed (F1)
    expect(warnings).toEqual([]);
  });

  it("works without a charge point", () => {
    const connector = new Connector(1, new Logger());
    const seen: string[] = [];
    connector.events.on("statusChange", ({ status }) => seen.push(status));
    connector.status = OCPPStatus.Charging;
    expect(connector.status).toBe(OCPPStatus.Charging);
    expect(seen).toEqual([OCPPStatus.Charging]);
  });
});
