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

/**
 * Issue #176: Preparing, Charging, Finishing, and post-stop Available are
 * now driven exclusively by ChargePoint's own startTransaction/
 * stopTransaction cascade (see ChargePoint.ts and the 17 scenario JSONs
 * edited alongside this test) rather than by scenario `statusChange`
 * nodes. This is the coverage gap flagged in review: a real end-to-end
 * regression pinning that, driven purely by the domain, each of the four
 * lifecycle statuses is emitted EXACTLY ONCE per run — no duplicates
 * (the bug #176 fixed) and no missing transitions (a regression the node
 * removal in isolation could introduce).
 *
 * Runs the REAL ScenarioExecutor against a REAL ChargePoint (no mocks),
 * following the harness established by cert16CoreScenarios.test.ts /
 * cert16RemoteStart.test.ts. There is no live transport, so — exactly as
 * in cert16RemoteStart.test.ts — the StartTransaction.conf CALLRESULT
 * that drives Charging is simulated directly via
 * StartTransactionResultHandler.
 */

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
  // No real transport connection is ever attempted (unused local port) —
  // matches the pattern used throughout src/cp/application/scenario/__tests__.
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

/** Simulate the CSMS's StartTransaction.conf CALLRESULT — the only thing
 *  that drives Charging (StartTransactionResultHandler), which never
 *  arrives on its own with no live transport connected. */
function simulateStartTransactionAccepted(
  cp: ChargePoint,
  connectorId: number,
  transactionId: number,
): void {
  new StartTransactionResultHandler(connectorId).handle(
    { transactionId, idTagInfo: { status: "Accepted" } },
    { chargePoint: cp, logger: new Logger() } satisfies HandlerContext,
  );
}

const LIFECYCLE_STATUSES = [
  OCPPStatus.Preparing,
  OCPPStatus.Charging,
  OCPPStatus.Finishing,
  OCPPStatus.Available,
] as const;

function countOccurrences(statuses: OCPPStatus[], target: OCPPStatus): number {
  return statuses.filter((s) => s === target).length;
}

function assertExactlyOnceEach(statuses: OCPPStatus[]): void {
  for (const status of LIFECYCLE_STATUSES) {
    expect(
      countOccurrences(statuses, status),
      `expected ${status} exactly once in [${statuses.join(", ")}]`,
    ).toBe(1);
  }
}

describe("domain-driven lifecycle status is emitted exactly once (#176)", () => {
  it("essential-cp-behavior (zero status nodes): Preparing/Charging/Finishing/Available each fire exactly once, driven entirely by the domain", async () => {
    const template = getTemplateById("essential-cp-behavior");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-176-ESSENTIAL");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const statuses: OCPPStatus[] = [];
    cp.events.on("connectorStatusChange", (e) => statuses.push(e.status));

    const scenario = template!.createScenario("CP-176-ESSENTIAL", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // Scenario runs delay-2s -> plug-in -> delay-1s (real wall time,
      // ~3s) before parking on the remoteStartTrigger node.
      await waitUntil(() => cp.isScenarioHandled(1), 6000);
      expect(connector!.transaction).toBeNull();

      cp.notifyRemoteStartReceived(1, "ESSENTIAL-LIVE-TAG");

      // tx-start runs: ChargePoint.startTransaction() drives Preparing
      // intrinsically (#176 domain fix), before StartTransaction.req is
      // even enqueued.
      await waitUntil(() => connector!.transaction !== null);
      expect(connector!.status).toBe(OCPPStatus.Preparing);

      simulateStartTransactionAccepted(cp, 1, 5501);
      await waitUntil(() => connector!.status === OCPPStatus.Charging);

      // meter-auto uses stopMode "evSettings" (capacity 75kWh, 20% ->
      // 80%), which blocks the scenario node on a real meter-value
      // threshold (45,000 Wh) with no timeout. Fast-forward past it
      // directly rather than waiting on real increments — resolves the
      // meterValueChange-driven wait exactly as a real charging session
      // crossing the threshold would.
      await waitUntil(() => connector!.isAutoMeterValueActive());
      cp.setMeterValue(1, 100_000);

      // Scenario proceeds past meter-auto and parks on remoteStopTrigger.
      await waitUntil(() => cp.isScenarioStopHandled(1), 2000);

      const txId = connector!.transaction!.id;
      if (txId == null) {
        throw new Error("expected transaction to have an id");
      }
      cp.notifyRemoteStopReceived(1, txId);

      // ChargePoint.stopTransaction() drives Finishing -> Available
      // synchronously and unconditionally (no scenario node involved).
      await waitUntil(() => connector!.status === OCPPStatus.Available);

      // plug-out is a no-op callback; end-1 follows immediately.
      await timeout(execution, 2000);

      assertExactlyOnceEach(statuses);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  }, 10000);

  it("cert16-tc011-remote-start-stop (edited, redundant status nodes removed): Preparing/Charging/Finishing/Available each fire exactly once", async () => {
    const template = getTemplateById("cert16-tc011-remote-start-stop");
    expect(template).toBeDefined();

    const cp = newChargePoint("CP-176-TC011");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const statuses: OCPPStatus[] = [];
    cp.events.on("connectorStatusChange", (e) => statuses.push(e.status));

    const scenario = template!.createScenario("CP-176-TC011", 1);
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: connector!,
    });
    const executor = new ScenarioExecutor(scenario, callbacks);
    const execution = executor.start();

    try {
      // No leading delay in this scenario — parks on remoteStartTrigger
      // almost immediately.
      await waitUntil(() => cp.isScenarioHandled(1), 3000);
      expect(connector!.transaction).toBeNull();

      cp.notifyRemoteStartReceived(1, "CERT011-LIVE-TAG");

      await waitUntil(() => connector!.transaction !== null);
      expect(connector!.status).toBe(OCPPStatus.Preparing);

      simulateStartTransactionAccepted(cp, 1, 5511);
      await waitUntil(() => connector!.status === OCPPStatus.Charging);

      // meter-auto here is unbounded (maxTime: 0, maxValue: 0 — "until
      // Remote Stop") so the node completes immediately without
      // blocking; the scenario parks on remoteStopTrigger right after.
      await waitUntil(() => cp.isScenarioStopHandled(1), 2000);

      const txId = connector!.transaction!.id;
      if (txId == null) {
        throw new Error("expected transaction to have an id");
      }
      cp.notifyRemoteStopReceived(1, txId);

      await waitUntil(() => connector!.status === OCPPStatus.Available);

      await timeout(execution, 2000);

      assertExactlyOnceEach(statuses);
    } finally {
      executor.stop();
      await timeout(
        execution.catch(() => undefined),
        500,
      ).catch(() => undefined);
    }
  }, 8000);
});
