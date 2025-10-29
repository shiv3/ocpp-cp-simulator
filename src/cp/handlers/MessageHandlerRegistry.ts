import { OCPPAction } from "../OcppTypes";
import { ChargePoint } from "../ChargePoint";
import { Logger } from "../Logger";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

/**
 * Context provided to message handlers
 */
export interface HandlerContext {
  chargePoint: ChargePoint;
  logger: Logger;
}

/**
 * Interface for handling CALL messages (requests from central system to charge point)
 */
export interface CallHandler<TRequest = unknown, TResponse = unknown> {
  handle(payload: TRequest, context: HandlerContext): TResponse;
}

/**
 * Interface for handling CALLRESULT messages (responses from central system to charge point)
 */
export interface CallResultHandler<TPayload = unknown> {
  handle(payload: TPayload, context: HandlerContext): void;
}

/**
 * Registry for message handlers using Strategy Pattern
 */
export class MessageHandlerRegistry {
  private callHandlers: Map<
    OCPPAction,
    CallHandler<unknown, unknown>
  > = new Map();

  private callResultHandlers: Map<
    OCPPAction,
    CallResultHandler<unknown>
  > = new Map();

  /**
   * Register a handler for CALL messages (incoming requests)
   */
  registerCallHandler<TRequest, TResponse>(
    action: OCPPAction,
    handler: CallHandler<TRequest, TResponse>,
  ): void {
    this.callHandlers.set(action, handler as CallHandler<unknown, unknown>);
  }

  /**
   * Register a handler for CALLRESULT messages (incoming responses)
   */
  registerCallResultHandler<TPayload>(
    action: OCPPAction,
    handler: CallResultHandler<TPayload>,
  ): void {
    this.callResultHandlers.set(
      action,
      handler as CallResultHandler<unknown>,
    );
  }

  /**
   * Get handler for CALL messages
   */
  getCallHandler(action: OCPPAction): CallHandler<unknown, unknown> | undefined {
    return this.callHandlers.get(action);
  }

  /**
   * Get handler for CALLRESULT messages
   */
  getCallResultHandler(
    action: OCPPAction,
  ): CallResultHandler<unknown> | undefined {
    return this.callResultHandlers.get(action);
  }

  /**
   * Check if a CALL handler is registered
   */
  hasCallHandler(action: OCPPAction): boolean {
    return this.callHandlers.has(action);
  }

  /**
   * Check if a CALLRESULT handler is registered
   */
  hasCallResultHandler(action: OCPPAction): boolean {
    return this.callResultHandlers.has(action);
  }
}

// Type-safe handler factory helpers
export type CallHandlerMap = {
  [OCPPAction.RemoteStartTransaction]: CallHandler<
    request.RemoteStartTransactionRequest,
    response.RemoteStartTransactionResponse
  >;
  [OCPPAction.RemoteStopTransaction]: CallHandler<
    request.RemoteStopTransactionRequest,
    response.RemoteStopTransactionResponse
  >;
  [OCPPAction.Reset]: CallHandler<
    request.ResetRequest,
    response.ResetResponse
  >;
  [OCPPAction.GetDiagnostics]: CallHandler<
    request.GetDiagnosticsRequest,
    response.GetDiagnosticsResponse
  >;
  [OCPPAction.TriggerMessage]: CallHandler<
    request.TriggerMessageRequest,
    response.TriggerMessageResponse
  >;
  [OCPPAction.GetConfiguration]: CallHandler<
    request.GetConfigurationRequest,
    response.GetConfigurationResponse
  >;
  [OCPPAction.ChangeConfiguration]: CallHandler<
    request.ChangeConfigurationRequest,
    response.ChangeConfigurationResponse
  >;
  [OCPPAction.ClearCache]: CallHandler<
    request.ClearCacheRequest,
    response.ClearCacheResponse
  >;
  [OCPPAction.UnlockConnector]: CallHandler<
    request.UnlockConnectorRequest,
    response.UnlockConnectorResponse
  >;
};

export type CallResultHandlerMap = {
  [OCPPAction.BootNotification]: CallResultHandler<response.BootNotificationResponse>;
  [OCPPAction.Authorize]: CallResultHandler<response.AuthorizeResponse>;
  [OCPPAction.StartTransaction]: CallResultHandler<response.StartTransactionResponse>;
  [OCPPAction.StopTransaction]: CallResultHandler<response.StopTransactionResponse>;
  [OCPPAction.Heartbeat]: CallResultHandler<response.HeartbeatResponse>;
  [OCPPAction.MeterValues]: CallResultHandler<response.MeterValuesResponse>;
  [OCPPAction.StatusNotification]: CallResultHandler<response.StatusNotificationResponse>;
  [OCPPAction.DataTransfer]: CallResultHandler<response.DataTransferResponse>;
};
