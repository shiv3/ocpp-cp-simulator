import type {
  AuthorizeRequestV201,
  BootNotificationRequestV201,
  GetBaseReportRequestV201,
  GetBaseReportResponseV201,
  GetVariablesRequestV201,
  HeartbeatRequestV201,
  MeterValuesRequestV201,
  NotifyReportRequestV201,
  SetVariablesRequestV201,
  StatusNotificationRequestV201,
  TransactionEventRequestV201,
} from "@cshil/ocpp-tools";
import {
  isValidGetBaseReportRequestV201,
  isValidGetVariablesRequestV201,
  isValidSetVariablesRequestV201,
} from "@cshil/ocpp-tools/validation/v201";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Logger } from "../../../shared/Logger";
import { buildBaseReportData } from "./baseReportV201";
import { handleGetVariablesV201 } from "./getVariablesV201";
import { handleSetVariablesV201 } from "./setVariablesV201";

export type V201Action =
  | "BootNotification"
  | "Heartbeat"
  | "StatusNotification"
  | "TransactionEvent"
  | "MeterValues"
  | "Authorize"
  | "NotifyReport";

export type V201RequestPayload =
  | BootNotificationRequestV201
  | HeartbeatRequestV201
  | StatusNotificationRequestV201
  | TransactionEventRequestV201
  | MeterValuesRequestV201
  | AuthorizeRequestV201
  | NotifyReportRequestV201;

export interface V201InboundContext {
  readonly chargePoint: ChargePoint;
  readonly logger: Logger;
  readonly sendCall: (action: V201Action, payload: V201RequestPayload) => void;
}

export interface V201HandlerResult {
  readonly response: unknown;
  readonly afterResult?: () => void;
}

export interface V201InboundHandler {
  readonly validate: (data: unknown) => boolean;
  readonly handle: (
    payload: unknown,
    ctx: V201InboundContext,
  ) => V201HandlerResult;
}

export type V201InboundRegistry = ReadonlyMap<string, V201InboundHandler>;

export function handleGetBaseReportV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetBaseReportRequestV201;
  const reportData = buildBaseReportData(ctx.chargePoint.configuration);
  const first = reportData[0];
  if (first === undefined) {
    return {
      response: {
        status: "EmptyResultSet",
      } satisfies GetBaseReportResponseV201,
    };
  }

  return {
    response: { status: "Accepted" } satisfies GetBaseReportResponseV201,
    afterResult: () =>
      ctx.sendCall("NotifyReport", {
        requestId: req.requestId,
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        reportData: [first, ...reportData.slice(1)],
      }),
  };
}

export function buildV201InboundRegistry(): V201InboundRegistry {
  return new Map<string, V201InboundHandler>([
    [
      "GetVariables",
      {
        validate: isValidGetVariablesRequestV201,
        handle: (p, ctx) => ({
          response: handleGetVariablesV201(
            p as GetVariablesRequestV201,
            ctx.chargePoint.configuration,
          ),
        }),
      },
    ],
    [
      "SetVariables",
      {
        validate: isValidSetVariablesRequestV201,
        handle: (p, ctx) => ({
          response: handleSetVariablesV201(
            p as SetVariablesRequestV201,
            ctx.chargePoint.configuration,
          ),
        }),
      },
    ],
    [
      "GetBaseReport",
      {
        validate: isValidGetBaseReportRequestV201,
        handle: handleGetBaseReportV201,
      },
    ],
  ]);
}
