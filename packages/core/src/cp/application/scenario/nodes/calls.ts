import type {
  CallResponseNodeData,
  ConfigSetNodeData,
  DataTransferNodeData,
  OcppCallNodeData,
  StatusNotificationNodeData,
  UnlockOutcomeNodeData,
  UseBehaviorNodeData,
} from "../ScenarioTypes";
import { resolveFrom } from "../resolveFrom";
import { jsonProblem } from "../../behavior/paramsSchema";
import type { Flow, NodeRunContext } from "./context";

/** Send a StatusNotification.req with the user-supplied payload. */
export async function executeStatusNotification(
  ctx: NodeRunContext,
  data: StatusNotificationNodeData,
): Promise<void> {
  // ScenarioRuntime resolves the bound connectorId for the runtime. When
  // the node specifies an explicit connectorId we use that (e.g. 0 to
  // target the CP main controller); otherwise the runtime fills in the
  // scenario's bound connector.
  if (!ctx.callbacks.onSendStatusNotification) return;
  const targetConnectorId = data.connectorId ?? -1;
  ctx.callbacks.onSendStatusNotification(targetConnectorId, data.status, {
    errorCode: data.errorCode,
    info: data.info,
    vendorErrorCode: data.vendorErrorCode,
    vendorId: data.vendorId,
  });
  ctx.callbacks.log?.(
    `StatusNotification connector=${targetConnectorId} status=${data.status}${
      data.errorCode ? ` errorCode=${data.errorCode}` : ""
    }`,
    "info",
  );
}
/** Pre-arm the connector's next UnlockConnector.req response. */
export async function executeUnlockOutcome(
  ctx: NodeRunContext,
  data: UnlockOutcomeNodeData,
): Promise<void> {
  if (!ctx.callbacks.onSetUnlockOutcome) {
    ctx.callbacks.log?.(
      "UnlockOutcome: no onSetUnlockOutcome callback wired",
      "warn",
    );
    return;
  }
  ctx.callbacks.onSetUnlockOutcome(data.outcome);
  ctx.callbacks.log?.(`Connector unlockResponse → ${data.outcome}`, "info");
}
/** Apply a ChangeConfiguration locally via the ConfigurationStore. */
export async function executeConfigSet(
  ctx: NodeRunContext,
  data: ConfigSetNodeData,
): Promise<void> {
  if (!ctx.callbacks.onConfigSet) {
    ctx.callbacks.log?.("ConfigSet: no onConfigSet callback wired", "warn");
    return;
  }
  ctx.callbacks.onConfigSet(data.key, data.value);
  ctx.callbacks.log?.(`ConfigSet ${data.key}='${data.value}'`, "info");
}
/** Send a CP-initiated DataTransfer.req with the user's vendor/message id. */
export async function executeDataTransfer(
  ctx: NodeRunContext,
  data: DataTransferNodeData,
): Promise<void> {
  if (!ctx.callbacks.onSendDataTransfer) {
    ctx.callbacks.log?.(
      "DataTransfer: no onSendDataTransfer callback wired",
      "warn",
    );
    return;
  }
  ctx.callbacks.onSendDataTransfer(data.vendorId, data.messageId, data.data);
  ctx.callbacks.log?.(`DataTransfer vendorId=${data.vendorId}`, "info");
}
/** Send an expert OCPP call (#389) and log the answer. A CALLERROR is an
 *  answer — often the one the scenario is after — so the flow goes on; a
 *  refusal or no answer throws and fails the run. */
export async function executeOcppCall(
  ctx: NodeRunContext,
  data: OcppCallNodeData,
  flow: Flow,
): Promise<void> {
  if (!ctx.callbacks.onSendOcppCall) {
    ctx.callbacks.log?.("OCPP call: no onSendOcppCall callback wired", "warn");
    return;
  }
  const { action, skipValidation, applyResponse } = data;
  const payload = resolveFrom(
    data.payload,
    ctx.fromScope(flow),
    `ocppCall(${action})`,
  ) as Record<string, unknown>;
  const call = ctx.callbacks.onSendOcppCall({
    action,
    payload,
    skipValidation,
    applyResponse,
  });
  // stop() must not wait up to 25 s for the answer. Once stopped, the call's
  // fate is no longer this run's: a later rejection is swallowed rather than
  // reported as a run error after `execution.stopped`.
  const outcome = await Promise.race([call, flow.scope.ended.then(() => null)]);
  if (outcome === null) {
    call.catch(() => undefined);
    return;
  }
  flow.response =
    outcome.kind === "callResult"
      ? {
          kind: "result",
          action,
          messageId: outcome.messageId,
          payload: outcome.payload,
        }
      : {
          kind: "error",
          action,
          messageId: outcome.messageId,
          errorCode: outcome.errorCode,
          errorDescription: outcome.errorDescription,
          errorDetails: outcome.errorDetails,
        };
  if (outcome.kind === "callResult") {
    ctx.callbacks.log?.(
      `OCPP call ${data.action} → CALLRESULT ${JSON.stringify(outcome.payload)}`,
      "info",
    );
  } else {
    ctx.callbacks.log?.(
      `OCPP call ${data.action} → CALLERROR ${outcome.errorCode}: ${outcome.errorDescription}`,
      "warn",
    );
  }
}
/**
 * Schema 1.5 (#566): answer the CALL this branch took over and wait until
 * the answer settled on the wire. An answer that was not delivered (the
 * connection closed or changed, the frame was dropped) fails the run.
 */
export async function executeCallResponse(
  ctx: NodeRunContext,
  data: CallResponseNodeData,
  flow: Flow,
): Promise<void> {
  const exchange = flow.exchange;
  if (!exchange) {
    throw new Error(
      'callResponse: this branch holds no CALL; place it after a csmsCallTrigger with behavior "replace"',
    );
  }
  if (flow.answered) {
    throw new Error(
      `callResponse: the ${exchange.action} CALL of this branch is already answered`,
    );
  }
  if (
    (data.kind === "accepted" || data.kind === "rejected") &&
    (data.payload !== undefined || data.skipValidation)
  ) {
    throw new Error(
      `callResponse: kind "${data.kind}" is the ${exchange.action} answer of the station's OCPP version and takes no payload`,
    );
  }
  const payload =
    data.kind === "result"
      ? (resolveFrom(
          data.payload ?? {},
          ctx.fromScope(flow),
          `callResponse(${exchange.action})`,
        ) as Record<string, unknown>)
      : undefined;
  const settled = await Promise.race([
    exchange.answer({
      kind: data.kind,
      ...(payload === undefined ? {} : { payload }),
      ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
      ...(data.errorDescription === undefined
        ? {}
        : { errorDescription: data.errorDescription }),
      ...(data.skipValidation ? { skipValidation: true } : {}),
    }),
    flow.scope.ended.then(() => null),
  ]);
  if (settled === null) {
    // Cancelled mid-answer (schema 1.9): the answer is on its way, never
    // answer the CALL again.
    if (flow.scope.cancelled) flow.answered = true;
    return;
  }
  flow.answered = true;
  if (!settled.delivered) {
    throw new Error(
      `callResponse: the answer to ${exchange.action} was not delivered (${settled.reason})`,
    );
  }
  ctx.callbacks.log?.(`Answered ${exchange.action} with ${data.kind}`, "info");
}
/** Schema 1.5 (#566): select a behavior loaded on the station. */
export function executeUseBehavior(
  ctx: NodeRunContext,
  nodeId: string,
  data: UseBehaviorNodeData,
): void {
  if (!ctx.callbacks.onUseBehavior) {
    throw new Error("useBehavior: this station cannot select behaviors");
  }
  const mode = data.mode ?? "use";
  if (mode !== "use" && mode !== "disable") {
    throw new Error(
      `useBehavior: mode must be "use" or "disable", got ${JSON.stringify(mode)}`,
    );
  }
  const params = data.params;
  if (params !== undefined) {
    const bad = jsonProblem(params, "params");
    if (bad || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(
        `useBehavior ${data.behaviorId}: params must be a JSON object${bad ? ` (${bad})` : ""}`,
      );
    }
    if (mode === "disable" && Object.keys(params).length > 0) {
      throw new Error(
        `useBehavior ${data.behaviorId}: mode "disable" takes no params`,
      );
    }
  }
  ctx.callbacks.onUseBehavior(data.behaviorId, nodeId, {
    mode,
    ...(params === undefined ? {} : { params }),
  });
  ctx.callbacks.log?.(
    mode === "disable"
      ? `Disabling behavior ${data.behaviorId} for this run`
      : `Using behavior ${data.behaviorId}` +
          (params && Object.keys(params).length > 0
            ? ` with params ${JSON.stringify(params)}`
            : ""),
    "info",
  );
}
