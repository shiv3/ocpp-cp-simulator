import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { OCPPAvailability } from "../../../domain/types/OcppTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

interface ChangeAvailability16Request {
  connectorId: number;
  type: string;
}

interface ChangeAvailability2Request {
  operationalStatus: OCPPAvailability;
  evse?: { id: number };
}

function statusOf(target: OCPPAvailability): OCPPStatus {
  return target === "Operative" ? OCPPStatus.Available : OCPPStatus.Unavailable;
}

/**
 * The default behavior of ChangeAvailability.
 *
 * Rules shared by both versions: a target with a transaction in flight answers
 * `Scheduled` and keeps the change in the connector's `scheduledAvailability`
 * until the transaction stops; an unknown connector answers `Rejected`;
 * otherwise `Accepted` and the connector goes `Available` or `Unavailable`
 * with a StatusNotification. Connector id (1.6) or no EVSE (2.x) 0 means the
 * main controller and every connector.
 *
 * OCPP 1.6 (§5.2) applies the change while it builds the answer, 2.x (G03)
 * once the answer settled. Both persist the availability. Connector status
 * and availability still live in `Connector`; they move into the engine state
 * with the connector-status behavior.
 */
export function availabilityBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.availability",
    onCall: {
      ChangeAvailability: {
        mode: "replace",
        handle: (request) =>
          isOcpp2Version(cp.ocppVersion)
            ? change2(cp, request as ChangeAvailability2Request)
            : change16(cp, request as ChangeAvailability16Request),
      },
    },
  };
}

function change16(cp: ChargePoint, req: ChangeAvailability16Request) {
  const target: OCPPAvailability =
    req.type === "Operative" ? "Operative" : "Inoperative";
  cp.logger.info(
    `ChangeAvailability connector=${req.connectorId} → ${target}`,
    LogType.OCPP,
  );

  if (req.connectorId === 0) {
    // §5.2: if any connector has an active transaction we have to defer,
    // even for the CP-wide form.
    let anyScheduled = false;
    for (const connector of cp.connectors.values()) {
      if (connector.transaction) {
        connector.scheduledAvailability = target;
        anyScheduled = true;
      }
    }
    if (anyScheduled) return { response: { status: "Scheduled" } };

    const cpStatus = statusOf(target);
    cp.updateConnectorStatus(0, cpStatus);
    for (const connector of cp.connectors.values()) {
      connector.availability = target;
      cp.updateConnectorStatus(connector.id, cpStatus);
    }
    cp.persistAvailability();
    return { response: { status: "Accepted" } };
  }

  const connector = cp.getConnector(req.connectorId);
  if (!connector) {
    // Unknown connector id: the spec has no explicit status, Rejected is
    // the closest match.
    return { response: { status: "Rejected" } };
  }
  if (connector.transaction) {
    connector.scheduledAvailability = target;
    return { response: { status: "Scheduled" } };
  }
  connector.availability = target;
  cp.updateConnectorStatus(req.connectorId, statusOf(target));
  cp.persistAvailability();
  return { response: { status: "Accepted" } };
}

function change2(cp: ChargePoint, req: ChangeAvailability2Request) {
  const target = req.operationalStatus;
  const connectorId = req.evse?.id;
  const nextStatus = statusOf(target);

  if (connectorId === undefined) {
    const active = [...cp.connectors.values()].filter((c) => c.transaction);
    if (active.length > 0) {
      // G04.FR.06 answers Scheduled while a transaction runs, but G04.FR.07 /
      // G04.FR.08 and TC_G_14_CS apply the change to the EVSEs without a
      // transaction at once; only the busy ones wait for their transaction.
      return {
        response: { status: "Scheduled" },
        after: async () => {
          for (const connector of cp.connectors.values()) {
            if (connector.transaction) {
              connector.scheduledAvailability = target;
              continue;
            }
            connector.availability = target;
            cp.updateConnectorStatus(connector.id, nextStatus);
          }
          cp.persistAvailability();
        },
      };
    }
    return {
      response: { status: "Accepted" },
      after: async () => {
        cp.updateConnectorStatus(0, nextStatus);
        for (const connector of cp.connectors.values()) {
          connector.availability = target;
          cp.updateConnectorStatus(connector.id, nextStatus);
        }
        cp.persistAvailability();
      },
    };
  }

  const connector = cp.getConnector(connectorId);
  if (!connector) return { response: { status: "Rejected" } };
  if (connector.transaction) {
    return {
      response: { status: "Scheduled" },
      after: async () => {
        connector.scheduledAvailability = target;
      },
    };
  }
  return {
    response: { status: "Accepted" },
    after: async () => {
      connector.availability = target;
      cp.updateConnectorStatus(connectorId, nextStatus);
      cp.persistAvailability();
    },
  };
}
