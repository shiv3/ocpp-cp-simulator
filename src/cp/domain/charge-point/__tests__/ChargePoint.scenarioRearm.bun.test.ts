import { describe, expect, it } from "bun:test";

import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import * as ocpp from "../../types/OcppTypes";

/**
 * A `triggerOn: "connect"` scenario is armed once per connect, and the arm is
 * recorded on `Connector.lastAutoStartedScenarioKey` so that re-emitting
 * `Available` (a status oscillation, a re-render, a repeated load) does not
 * restart a scenario that is already up.
 *
 * The arm must NOT survive the socket dying. Both auto-start engines --
 * `CLIChargePointService.tryAutoStartForConnector` (daemon) and the
 * `useEffect` in `src/components/Connector.tsx` (browser local mode) -- gate
 * on that key, so a stale arm means a reconnect never re-fires the scenario.
 * In the daemon that silently kills the CLI-bootstrapped RemoteStart
 * responder: the CP reconnects and boots, but nothing answers a
 * RemoteStartTransaction until an operator re-fires the template by hand.
 *
 * The key is also persisted (`connector_runtime.last_auto_started_scenario_key`),
 * so clearing has to happen before the disconnect's status cascade writes the
 * snapshot -- otherwise the stale arm outlives a process restart too.
 */
function makeChargePoint(connectorCount = 2): ChargePoint {
  return new ChargePoint(
    "cp-rearm",
    DefaultBootNotification,
    connectorCount,
    "ws://127.0.0.1:65534/never",
    null,
    null,
  );
}

describe("ChargePoint disconnect clears the connect-trigger arm", () => {
  it("clears lastAutoStartedScenarioKey on every connector", () => {
    const cp = makeChargePoint();
    cp.getConnector(1)!.lastAutoStartedScenarioKey =
      "scenario-a:struct:connect:";
    cp.getConnector(2)!.lastAutoStartedScenarioKey =
      "scenario-b:struct:connect:";

    cp.disconnect();

    expect(cp.getConnector(1)!.lastAutoStartedScenarioKey).toBeNull();
    expect(cp.getConnector(2)!.lastAutoStartedScenarioKey).toBeNull();
  });

  it("clears the arm before the Unavailable cascade, so the persisted snapshot is clean", () => {
    // persistConnectorRuntime is driven off the connector statusChange the
    // Unavailable cascade emits. If the arm were cleared after that cascade the
    // row written on disconnect would still hold the stale key and a daemon
    // restart would rehydrate it.
    const cp = makeChargePoint(1);
    const connector = cp.getConnector(1)!;
    connector.status = ocpp.OCPPStatus.Available;
    connector.lastAutoStartedScenarioKey = "scenario-a:struct:connect:";

    const armAtCascade: Array<string | null> = [];
    connector.events.on("statusChange", () => {
      armAtCascade.push(connector.lastAutoStartedScenarioKey);
    });

    cp.disconnect();

    expect(armAtCascade.length).toBeGreaterThan(0);
    expect(armAtCascade.every((key) => key === null)).toBe(true);
  });

  it("leaves the arm alone while the CP stays connected", () => {
    // Only a dead socket re-arms. A status oscillation must not, or a
    // long-running scenario would be restarted underneath itself.
    const cp = makeChargePoint(1);
    const connector = cp.getConnector(1)!;
    connector.lastAutoStartedScenarioKey = "scenario-a:struct:connect:";

    connector.status = ocpp.OCPPStatus.Preparing;
    connector.status = ocpp.OCPPStatus.Charging;

    expect(connector.lastAutoStartedScenarioKey).toBe(
      "scenario-a:struct:connect:",
    );
  });
});
