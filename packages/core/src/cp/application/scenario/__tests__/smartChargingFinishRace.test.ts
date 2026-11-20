import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioExecutorCallbacks } from "../ScenarioTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { getTemplateById } from "../../../../utils/scenarioTemplates";

/**
 * `smart-charging` waits for Finishing after its Auto MeterValue node. A stop
 * during the meter ends that node, and the connector goes through Finishing
 * (and on to Available) in the same turn, before a wait that only starts once
 * the meter returned could arm: the run hung on a status it had already
 * missed. The Finishing wait now runs in a branch beside the meter, armed
 * before any stop can happen.
 *
 * The status wait is edge-triggered here like a connector's status events
 * once the connector has moved on: it sees a Finishing only if it was armed
 * before that Finishing was emitted.
 */
describe("smart-charging: a stop during the meter", () => {
  it("completes although Finishing is emitted as the meter ends", async () => {
    const scenario = getTemplateById("smart-charging")!.createScenario("cp", 1);

    const finishingWaiters: Array<() => void> = [];
    let endMeter: () => void = () => undefined;

    const callbacks = {
      onWaitForStatus: (status: OCPPStatus) =>
        status === OCPPStatus.Charging
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              finishingWaiters.push(resolve);
            }),
      onStartAutoMeterValue: () => undefined,
      // The auto-meter node holds until its transaction ends.
      onWaitForMeterValue: () =>
        new Promise<void>((resolve) => {
          endMeter = resolve;
        }),
    } as unknown as ScenarioExecutorCallbacks;

    const executor = new ScenarioExecutor(scenario, callbacks);
    const run = executor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The stop: Finishing is emitted (only waits armed now see it), then the
    // meter node's transaction-ended wake-up follows.
    for (const resolve of finishingWaiters.splice(0)) resolve();
    endMeter();

    const outcome = await Promise.race([
      run.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(resolve, 1_000, "hung")),
    ]);
    executor.stop();
    expect(outcome).toBe("completed");
  });
});
