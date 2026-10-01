import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  DataTransferResponseV16,
  DiagnosticsStatusNotificationResponseV16,
  FirmwareStatusNotificationResponseV16,
  HeartbeatResponseV16,
  LogStatusNotificationResponseV16,
  MeterValuesResponseV16,
  SecurityEventNotificationResponseV16,
  SignedFirmwareStatusNotificationResponseV16,
  StatusNotificationResponseV16,
} from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";

export class HeartbeatResultHandler implements CallResultHandler<HeartbeatResponseV16> {
  handle(payload: HeartbeatResponseV16, context: HandlerContext): void {
    context.logger.debug(
      `Received heartbeat response: ${payload.currentTime}`,
      LogType.HEARTBEAT,
    );
  }
}

export class MeterValuesResultHandler implements CallResultHandler<MeterValuesResponseV16> {
  /** `connectorId`: the connector the MeterValues.req was sent for. */
  constructor(private readonly connectorId?: number) {}

  handle(payload: MeterValuesResponseV16, context: HandlerContext): void {
    if (this.connectorId !== undefined) {
      const connector = context.chargePoint.getConnector(this.connectorId);
      if (connector && connector.transaction) {
        connector.transaction.meterSent = true;
      }
    }
    context.logger.debug(
      `Meter values sent successfully: ${JSON.stringify(payload)}`,
      LogType.METER_VALUE,
    );
  }
}

export class StatusNotificationResultHandler implements CallResultHandler<StatusNotificationResponseV16> {
  handle(
    payload: StatusNotificationResponseV16,
    context: HandlerContext,
  ): void {
    context.logger.debug(
      `Status notification sent successfully: ${JSON.stringify(payload)}`,
      LogType.STATUS,
    );
  }
}

export class DataTransferResultHandler implements CallResultHandler<DataTransferResponseV16> {
  handle(payload: DataTransferResponseV16, context: HandlerContext): void {
    context.logger.info(
      `Data transfer sent successfully: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }
}

type EmptyConfirmationResponseV16 =
  | DiagnosticsStatusNotificationResponseV16
  | FirmwareStatusNotificationResponseV16
  | SignedFirmwareStatusNotificationResponseV16
  | SecurityEventNotificationResponseV16
  | LogStatusNotificationResponseV16;

/**
 * For CP-initiated notifications whose `.conf` is empty by spec: the CSMS
 * acknowledging it is the whole exchange, so there is nothing to handle
 * and nothing to warn about (#407).
 */
export class EmptyConfirmationResultHandler implements CallResultHandler<EmptyConfirmationResponseV16> {
  constructor(private readonly action: string) {}

  handle(
    _payload: EmptyConfirmationResponseV16,
    context: HandlerContext,
  ): void {
    context.logger.debug(`${this.action} acknowledged`, LogType.OCPP);
  }
}
