import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";
import type { MonitoringEvent } from "../../cp/domain/monitoring/MonitorEvaluation";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});
const start = async (o: Parameters<typeof runBehavior>[0]) => {
  const r = await runBehavior(o);
  runs.push(r);
  return r;
};
async function charge(run: BehaviorRun) {
  run.cp.updateConnectorStatus(1, "Preparing" as never);
  await run.settle();
  await run.cp.startTransaction("TAG", 1);
  await run.advanceInSteps(1000, 100);
}
async function reconnect(run: BehaviorRun) {
  run.cp.connect();
  await run.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 5000 });
  await run.settle();
  await run.advanceInSteps(2000, 200);
}
const EVENT: MonitoringEvent = {
  eventId: 7,
  timestamp: new Date("2030-01-01T00:00:00.000Z"),
  monitor: {
    id: 1,
    type: "UpperThreshold",
    severity: 2,
    value: 400,
    transaction: false,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    origin: "CustomMonitor",
  } as never,
  trigger: "Alerting",
  cleared: false,
  actualValue: "500",
};

describe("2.x beforeSend: the answer is matched with the CALL as built (doc claim)", () => {
  for (const rewrite of [false, true])
    test(`2.x Authorize rewrite=${rewrite}: a Blocked verdict stops the start (false = control)`, async () => {
      const b: Behavior = {
        api: 1,
        id: "r",
        beforeSend: {
          Authorize: (p) =>
            rewrite
              ? {
                  ...p,
                  idToken: {
                    ...(p.idToken as object),
                    idToken: "REWRITTEN",
                  },
                }
              : undefined,
        },
      };
      const run = await start({
        version: "2.0.1",
        behaviors: [b],
        seed: "x",
        responders: {
          Authorize: () => ({ idTokenInfo: { status: "Blocked" } }),
        },
      });
      run.cp.updateConnectorStatus(1, "Preparing" as never);
      await run.settle();
      const started = run.cp.startTransaction("TAG", 1);
      await run.advanceInSteps(60_000, 1000);
      const res = await started;
      expect(run.callsOf("Authorize")).toHaveLength(1);
      expect(res.started).toBe(false);
      expect(
        run
          .callsOf("TransactionEvent")
          .filter(
            (f) => (f.payload as { eventType: string }).eventType === "Started",
          ),
      ).toHaveLength(0);
    });
});

describe("2.x: a queued NotifyEvent dropped by beforeSend on replay", () => {
  for (const drop of [false, true])
    test(`does not hold the offline queue (drop=${drop}; false = control)`, async () => {
      const b: Behavior = {
        api: 1,
        id: "dropnotify",
        beforeSend: {
          NotifyEvent: () => (drop ? { drop: true } : undefined),
        },
      };
      const run = await start({ version: "2.0.1", behaviors: [b], seed: "x" });
      await charge(run);
      const c = run.cp.getConnector(1)!;
      run.cp.disconnect();
      await run.settle();
      (
        run.cp as unknown as {
          _outbox: { queueNotifyEvent(e: MonitoringEvent[]): void };
        }
      )._outbox.queueNotifyEvent([EVENT]);
      run.cp.stopTransaction(c);
      await run.settle();
      await reconnect(run);
      const ended = run
        .callsOf("TransactionEvent")
        .filter(
          (f) => (f.payload as { eventType: string }).eventType === "Ended",
        );
      // the Ended event queued behind the NotifyEvent must be replayed
      expect(ended).toHaveLength(1);
    });
});
