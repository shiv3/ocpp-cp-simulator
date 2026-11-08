import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  DataTransferRequestV16,
  DataTransferResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import type { DataTransferResponder } from "../../../../domain/types/DataTransfer";
import type { DataTransferVendorRegistry } from "../../../../domain/transport/IChargePointMessageHandler";
import { LogType } from "../../../../shared/Logger";

/**
 * Handles CSMS-initiated DataTransfer.req per OCPP 1.6 §4.3 / §5.6.
 *
 * Behaviour:
 * - Unknown `vendorId` → `{ status: "UnknownVendorId" }`
 * - Known vendor but unknown `messageId` → `{ status: "UnknownMessageId" }`
 * - Known vendor + handler returns null → `UnknownMessageId`
 * - Otherwise the responder's status / data is returned verbatim
 *
 * The vendor map is intentionally instance-scoped (not module-static) so
 * tests / scenarios can register custom responders without leaking state
 * between charge points.
 */
export class DataTransferHandler
  implements
    CallHandler<DataTransferRequestV16, DataTransferResponseV16>,
    DataTransferVendorRegistry
{
  private readonly vendors = new Map<string, DataTransferResponder>();

  /**
   * Register a responder for a given vendorId. Replaces any previous
   * registration for the same vendorId.
   */
  registerVendor(vendorId: string, responder: DataTransferResponder): void {
    this.vendors.set(vendorId, responder);
  }

  unregisterVendor(vendorId: string): void {
    this.vendors.delete(vendorId);
  }

  handle(
    payload: DataTransferRequestV16,
    context: HandlerContext,
  ): DataTransferResponseV16 {
    context.logger.info(
      `DataTransfer received: vendorId=${payload.vendorId}` +
        (payload.messageId ? ` messageId=${payload.messageId}` : ""),
      LogType.OCPP,
    );

    const responder = this.vendors.get(payload.vendorId);
    if (!responder) {
      return { status: "UnknownVendorId" };
    }

    const result = responder.handle(payload.messageId, payload.data);
    if (!result) {
      return { status: "UnknownMessageId" };
    }
    return result;
  }
}
