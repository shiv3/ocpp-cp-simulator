import { describe, expect, it } from "vitest";
import { Outbox } from "../Outbox";
import type { IChargePointMessageHandler } from "../../../infrastructure/transport/IChargePointMessageHandler";
import { DataTransferHandler } from "../../../infrastructure/transport/handlers";
import type { BootNotification } from "../../types/OcppTypes";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../../connector/Transaction";
import type { TransactionLifecycleEvent } from "../TransactionLifecycleEvent";

type HandlerMethod = keyof IChargePointMessageHandler;

interface CallRecord {
  method: HandlerMethod;
  args: unknown[];
}

class FakeMessageHandler implements IChargePointMessageHandler {
  readonly calls: CallRecord[] = [];
  readonly dataTransferHandler = new DataTransferHandler();

  private record(method: HandlerMethod, args: readonly unknown[]): void {
    this.calls.push({ method, args: [...args] });
  }

  sendBootNotification(
    ...args: Parameters<IChargePointMessageHandler["sendBootNotification"]>
  ): ReturnType<IChargePointMessageHandler["sendBootNotification"]> {
    this.record("sendBootNotification", args);
  }

  sendHeartbeat(): ReturnType<IChargePointMessageHandler["sendHeartbeat"]> {
    this.record("sendHeartbeat", []);
  }

  sendStatusNotification(
    ...args: Parameters<IChargePointMessageHandler["sendStatusNotification"]>
  ): ReturnType<IChargePointMessageHandler["sendStatusNotification"]> {
    this.record("sendStatusNotification", args);
  }

  authorize(
    ...args: Parameters<IChargePointMessageHandler["authorize"]>
  ): ReturnType<IChargePointMessageHandler["authorize"]> {
    this.record("authorize", args);
  }

  sendTransactionEvent(
    ...args: Parameters<IChargePointMessageHandler["sendTransactionEvent"]>
  ): ReturnType<IChargePointMessageHandler["sendTransactionEvent"]> {
    this.record("sendTransactionEvent", args);
  }

  sendMeterValue(
    ...args: Parameters<IChargePointMessageHandler["sendMeterValue"]>
  ): ReturnType<IChargePointMessageHandler["sendMeterValue"]> {
    this.record("sendMeterValue", args);
  }

  sendDataTransfer(
    ...args: Parameters<IChargePointMessageHandler["sendDataTransfer"]>
  ): ReturnType<IChargePointMessageHandler["sendDataTransfer"]> {
    this.record("sendDataTransfer", args);
  }

  sendDiagnosticsStatusNotification(
    ...args: Parameters<
      IChargePointMessageHandler["sendDiagnosticsStatusNotification"]
    >
  ): ReturnType<
    IChargePointMessageHandler["sendDiagnosticsStatusNotification"]
  > {
    this.record("sendDiagnosticsStatusNotification", args);
  }

  sendFirmwareStatusNotification(
    ...args: Parameters<
      IChargePointMessageHandler["sendFirmwareStatusNotification"]
    >
  ): ReturnType<IChargePointMessageHandler["sendFirmwareStatusNotification"]> {
    this.record("sendFirmwareStatusNotification", args);
  }

  setBootStatus(
    ...args: Parameters<IChargePointMessageHandler["setBootStatus"]>
  ): ReturnType<IChargePointMessageHandler["setBootStatus"]> {
    this.record("setBootStatus", args);
  }

  getDataTransferHandler(): ReturnType<
    IChargePointMessageHandler["getDataTransferHandler"]
  > {
    this.record("getDataTransferHandler", []);
    return this.dataTransferHandler;
  }

  onWebSocketClosed(): ReturnType<
    IChargePointMessageHandler["onWebSocketClosed"]
  > {
    this.record("onWebSocketClosed", []);
  }

  flushPendingQueue(): ReturnType<
    IChargePointMessageHandler["flushPendingQueue"]
  > {
    this.record("flushPendingQueue", []);
  }
}

function expectCall(
  handler: FakeMessageHandler,
  method: HandlerMethod,
  args: unknown[],
): void {
  expect(handler.calls).toEqual([{ method, args }]);
  handler.calls.length = 0;
}

describe("Outbox", () => {
  it("delegates every outbound handler method with the same arguments", () => {
    const handler = new FakeMessageHandler();
    const outbox = new Outbox(handler);
    const bootPayload: BootNotification = {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
    };
    const statusOpts: Parameters<
      IChargePointMessageHandler["sendStatusNotification"]
    >[2] = {
      errorCode: "NoError",
      info: "available",
      vendorErrorCode: "VENDOR-1",
      vendorId: "Vendor",
      timestamp: new Date("2026-01-02T03:04:05.000Z"),
    };
    const transaction: Transaction = {
      id: 42,
      connectorId: 1,
      tagId: "TAG-1",
      meterStart: 100,
      meterStop: 200,
      startTime: new Date("2026-01-02T03:04:05.000Z"),
      stopTime: new Date("2026-01-02T04:04:05.000Z"),
      meterSent: false,
    };
    const bootStatus: Parameters<
      IChargePointMessageHandler["setBootStatus"]
    >[0] = {
      status: "Rejected",
      retryAfter: new Date("2026-01-02T05:04:05.000Z"),
    };

    outbox.sendBootNotification(bootPayload);
    expectCall(handler, "sendBootNotification", [bootPayload]);

    outbox.sendHeartbeat();
    expectCall(handler, "sendHeartbeat", []);

    outbox.sendStatusNotification(1, OCPPStatus.Available, statusOpts);
    expectCall(handler, "sendStatusNotification", [
      1,
      OCPPStatus.Available,
      statusOpts,
    ]);

    outbox.authorize("TAG-1");
    expectCall(handler, "authorize", ["TAG-1"]);

    const event: TransactionLifecycleEvent = {
      phase: "ended",
      transaction,
      connectorId: 1,
    };
    outbox.sendTransactionEvent(event);
    expectCall(handler, "sendTransactionEvent", [event]);

    outbox.sendMeterValue(42, 1, "Sample.Periodic");
    expectCall(handler, "sendMeterValue", [42, 1, "Sample.Periodic"]);

    outbox.sendDataTransfer("Vendor", "Message", '{"ok":true}');
    expectCall(handler, "sendDataTransfer", [
      "Vendor",
      "Message",
      '{"ok":true}',
    ]);

    outbox.sendDiagnosticsStatusNotification("Uploading");
    expectCall(handler, "sendDiagnosticsStatusNotification", ["Uploading"]);

    outbox.sendFirmwareStatusNotification("Downloaded");
    expectCall(handler, "sendFirmwareStatusNotification", ["Downloaded"]);

    outbox.setBootStatus(bootStatus);
    expectCall(handler, "setBootStatus", [bootStatus]);

    expect(outbox.getDataTransferHandler()).toBe(handler.dataTransferHandler);
    expectCall(handler, "getDataTransferHandler", []);

    outbox.onWebSocketClosed();
    expectCall(handler, "onWebSocketClosed", []);

    outbox.flushPendingQueue();
    expectCall(handler, "flushPendingQueue", []);
  });
});
