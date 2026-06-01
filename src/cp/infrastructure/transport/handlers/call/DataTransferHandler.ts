import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

/**
 * Per-vendor DataTransfer responder. Implementations decide whether a given
 * `messageId` is supported; returning `null` lets the handler fall through
 * to `UnknownMessageId`.
 */
export interface DataTransferResponder {
  handle(
    messageId: string | undefined,
    data: string | undefined,
  ): { status: "Accepted" | "Rejected"; data?: string } | null;
}

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
    CallHandler<request.DataTransferRequest, response.DataTransferResponse>
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
    payload: request.DataTransferRequest,
    context: HandlerContext,
  ): response.DataTransferResponse {
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
