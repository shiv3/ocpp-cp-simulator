import { describe, expect, it } from "bun:test";

import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * A template instantiated per connector shares one scenario NAME, which is the
 * only prefix the executor puts on its own log lines. So when a disconnect
 * killed every connector's run at once, the field report saw 7 byte-identical
 * "Scenario execution failed: Disconnected while waiting for remote start"
 * lines with no way to tell them apart. The runtime logger adds the bound
 * connector.
 */
function makeChargePoint(): ChargePoint {
  return new ChargePoint(
    "cp-log-prefix",
    DefaultBootNotification,
    2,
    "ws://127.0.0.1:65534/never",
    null,
    null,
  );
}

describe("scenario log lines carry the bound connector", () => {
  it("prefixes the connector id, so same-named runs stay distinguishable", () => {
    const cp = makeChargePoint();
    const seen: string[] = [];

    for (const connectorId of [1, 2]) {
      const callbacks = createScenarioExecutorCallbacks({
        chargePoint: cp,
        connector: cp.getConnector(connectorId)!,
        hooks: { log: (message) => seen.push(message) },
      });
      callbacks.log?.(
        "[Essential CP Behavior] Scenario execution failed: Disconnected while waiting for remote start",
        "error",
      );
    }

    expect(seen).toEqual([
      "[connector 1] [Essential CP Behavior] Scenario execution failed: Disconnected while waiting for remote start",
      "[connector 2] [Essential CP Behavior] Scenario execution failed: Disconnected while waiting for remote start",
    ]);
    expect(new Set(seen).size).toBe(2);
  });

  it("prefixes the CP log the same way", () => {
    const cp = makeChargePoint();
    const logged: string[] = [];
    cp.events.on("log", ({ message }) => logged.push(message));

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector: cp.getConnector(2)!,
    });
    callbacks.log?.(
      "[Demo] Scenario execution started (mode: oneshot)",
      "info",
    );

    expect(
      logged.some((m) =>
        m.includes("[connector 2] [Demo] Scenario execution started"),
      ),
    ).toBe(true);
  });
});
