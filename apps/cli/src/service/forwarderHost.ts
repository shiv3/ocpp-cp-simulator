import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { AutoTrafficRunner } from "@ocpp-cp-simulator/core/cp/application/services/AutoTrafficRunner";
import type { ChargePointInitOptions } from "../types";
import type { CLIEvent, SessionSettledInfo } from "./cliEvents";
import type { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";

/**
 * What the event forwarders need from `CLIChargePointService`. Reassigned
 * fields (`unsubscribes`, `connectorUnsubscribes`, `init`) are getters /
 * setters so the forwarders always see the service's current value.
 */
export interface ForwarderHost {
  readonly chargePoint: ChargePoint;
  readonly unsubscribes: Array<() => void>;
  readonly connectorUnsubscribes: Array<() => void>;
  init: ChargePointInitOptions;
  readonly autoTraffic: Map<number, AutoTrafficRunner>;
  emit(evt: CLIEvent): void;
  notifySessionSettled(info: SessionSettledInfo): void;
  persistConnectorRuntime(
    connector: ReturnType<ChargePoint["connectors"]["get"]>,
    connectorId: number,
  ): void;
  handleConnectAutoStart(): void;
  handleStatusAutoStart(connectorId: number, status: OCPPStatus): void;
  handleStatusChangeAutoTrigger(
    connectorId: number,
    previousStatus: OCPPStatus,
    status: OCPPStatus,
  ): void;
  attachStateHistoryForwarder(): void;
}
