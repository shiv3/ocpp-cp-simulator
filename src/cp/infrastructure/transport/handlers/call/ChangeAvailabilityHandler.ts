import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";
import {
  OCPPAvailability,
  OCPPStatus,
} from "../../../../domain/types/OcppTypes";

/**
 * Handles ChangeAvailability.req per OCPP 1.6 §5.2:
 *
 * - `connectorId === 0` applies to the CP main controller AND every
 *   connector simultaneously.
 * - For any connector with an active transaction, return `Scheduled` and
 *   defer the change to the connector's `scheduledAvailability` field so
 *   ChargePoint applies it when the transaction stops.
 * - Returning `Accepted` when the CP is already in the requested state is
 *   spec-compliant.
 * - On a successful immediate change, the CP must follow up with a
 *   StatusNotification.req reflecting the new state. `updateConnectorStatus`
 *   already fires that.
 */
export class ChangeAvailabilityHandler
  implements
    CallHandler<ChangeAvailabilityRequestV16, ChangeAvailabilityResponseV16>
{
  handle(
    payload: ChangeAvailabilityRequestV16,
    context: HandlerContext,
  ): ChangeAvailabilityResponseV16 {
    const target: OCPPAvailability =
      payload.type === "Operative" ? "Operative" : "Inoperative";

    context.logger.info(
      `ChangeAvailability connector=${payload.connectorId} → ${target}`,
      LogType.OCPP,
    );

    if (payload.connectorId === 0) {
      return this.applyChargePoint(target, context);
    }
    return this.applyConnector(payload.connectorId, target, context);
  }

  private applyChargePoint(
    target: OCPPAvailability,
    context: HandlerContext,
  ): ChangeAvailabilityResponseV16 {
    const { chargePoint } = context;
    // §5.2: if any connector has an active transaction we have to defer,
    // even for the CP-wide form.
    let anyScheduled = false;
    for (const connector of chargePoint.connectors.values()) {
      if (connector.transaction) {
        connector.scheduledAvailability = target;
        anyScheduled = true;
      }
    }
    if (anyScheduled) {
      return { status: "Scheduled" };
    }

    // Apply immediately to the CP main controller and every connector.
    const cpStatus =
      target === "Operative" ? OCPPStatus.Available : OCPPStatus.Unavailable;
    chargePoint.updateConnectorStatus(0, cpStatus);
    for (const connector of chargePoint.connectors.values()) {
      connector.availability = target;
      chargePoint.updateConnectorStatus(connector.id, cpStatus);
    }
    chargePoint.persistAvailability();
    return { status: "Accepted" };
  }

  private applyConnector(
    connectorId: number,
    target: OCPPAvailability,
    context: HandlerContext,
  ): ChangeAvailabilityResponseV16 {
    const connector = context.chargePoint.getConnector(connectorId);
    if (!connector) {
      // Unknown connector id — spec doesn't have an explicit status for
      // this; Rejected is the closest match.
      return { status: "Rejected" };
    }

    if (connector.transaction) {
      connector.scheduledAvailability = target;
      return { status: "Scheduled" };
    }

    connector.availability = target;
    const next =
      target === "Operative" ? OCPPStatus.Available : OCPPStatus.Unavailable;
    context.chargePoint.updateConnectorStatus(connectorId, next);
    context.chargePoint.persistAvailability();
    return { status: "Accepted" };
  }
}
