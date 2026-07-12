import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { getTemplateById } from "../../../../utils/scenarioTemplates";
import { StartTransactionResultHandler } from "../../../infrastructure/transport/handlers/callresult/TransactionResultHandlers";
import { Logger } from "../../../shared/Logger";
import type { HandlerContext } from "../../../infrastructure/transport/handlers/MessageHandlerRegistry";

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitUntil(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function newChargePoint(id: string): ChargePoint {
  // wsUrl points at an unused local port — no real transport connection is
  // ever attempted in this test, matching the pattern used by
  // ScenarioLifecycle.wave1.test.ts / ScenarioExecutor.nodes.test.ts.
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

describe("cert16-tc010-remote-start (built-in certification template)", () => {
  it("parks on RemoteStartTransaction, then runs Preparing → StartTransaction → Charging → bounded auto-meter", async () => {
    const template = getTemplateById("cert16-tc010-remote-start");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-CERT-TC010");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const scenario = template!.createScenario("CP-CERT-TC010", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Scenario is parked on the RemoteStartTrigger node waiting for the
      // CSMS's RemoteStartTransaction.req.
      await waitUntil(() => cp.isScenarioHandled(1));
      expect(connector!.transaction).toBeNull();

      // Simulate the CSMS issuing RemoteStartTransaction.req — the same
      // entry point the real RemoteStartTransaction handler uses.
      cp.notifyRemoteStartReceived(1, "CERT010-LIVE-TAG");

      // The scenario's own "Set Preparing"/"Set Charging" nodes were
      // removed (#176) — Preparing is now driven intrinsically by
      // ChargePoint.startTransaction() (request-time), and Charging is
      // only driven by StartTransactionResultHandler on the
      // StartTransaction.conf CALLRESULT. This test has no live transport
      // (see newChargePoint's comment), so simulate that CALLRESULT
      // arriving directly, exactly as a real CSMS accepting the start
      // would trigger it.
      await waitUntil(() => connector!.transaction !== null);
      new StartTransactionResultHandler(1).handle(
        { transactionId: 1010, idTagInfo: { status: "Accepted" } },
        { chargePoint: cp, logger: new Logger() } satisfies HandlerContext,
      );

      await waitUntil(() => connector!.status === OCPPStatus.Charging);

      // StartTransaction.req used the tagId captured from the
      // RemoteStartTransaction.req, not the node's fallback tagId.
      expect(connector!.transaction?.tagId).toBe("CERT010-LIVE-TAG");
      // The bounded auto-meter (meter-auto node) is running in the
      // background; the scenario is parked inside that node's wait.
      await waitUntil(() => connector!.isAutoMeterValueActive());
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  });
});
