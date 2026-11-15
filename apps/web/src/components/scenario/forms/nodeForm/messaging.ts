import {
  type CsmsCallTriggerNodeData,
  type CallResponseNodeData,
  type CallResponseSpec,
  type OcppCallNodeData,
  type UseBehaviorNodeData,
  type ChoiceNodeData,
  NOTIFY_KINDS,
  type NotifyNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
  type InboundPolicyNodeData,
  type ResponseOverrideNodeData,
  type ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { NOTIFY_STATUSES } from "../notifyStatuses";
import type { NodeFormData } from "../types";
import {
  compactDefined,
  stringValue,
  optionalString,
  optionalNumber,
  optionalBoolean,
  asCsmsCallTriggerAction,
  asPayloadCondition,
  asResponseOverrideAction,
  asResponseOverrideStatus,
  asInboundPolicyAction,
  asInboundPolicyMode,
  asInboundPolicyErrorCode,
} from "./coerce";

/** An ocppCall payload as saved (#389): an object as is; anything else as
 *  the text that was authored, never replaced by `{}` — the run then refuses
 *  the step instead of silently sending a different, valid payload. */
function ocppCallPayload(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return JSON.stringify(value) ?? "";
}

export function ocppCallNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<OcppCallNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: stringValue(data.action),
    payload: ocppCallPayload(data.payload),
    skipValidation: optionalBoolean(data.skipValidation),
    applyResponse: optionalBoolean(data.applyResponse),
  });
}

export function ocppCallFormToNodeData(
  formData: NodeFormData,
): OcppCallNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: stringValue(formData.action),
    payload: ocppCallPayload(formData.payload) as Record<string, unknown>,
    skipValidation: optionalBoolean(formData.skipValidation),
    applyResponse: optionalBoolean(formData.applyResponse),
  }) as OcppCallNodeData;
}

const CALL_RESPONSE_KINDS = new Set<string>([
  "result",
  "error",
  "none",
  "accepted",
  "rejected",
]);

/** The fields of a CallResponseSpec as the form edits them and as saved. A
 *  payload that is not an object is kept as typed (see ocppCallPayload). */
function callResponseSpecFields(source: Record<string, unknown>) {
  const kind = CALL_RESPONSE_KINDS.has(source.kind as string)
    ? (source.kind as CallResponseSpec["kind"])
    : "result";
  // Schema 1.6 (#654): accepted / rejected carry nothing else.
  if (kind === "accepted" || kind === "rejected") {
    return {
      kind,
      payload: undefined,
      errorCode: undefined,
      errorDescription: undefined,
    };
  }
  return {
    kind,
    payload:
      source.payload === undefined
        ? undefined
        : (ocppCallPayload(source.payload) as Record<string, unknown>),
    errorCode: optionalString(source.errorCode),
    errorDescription: optionalString(source.errorDescription),
  };
}

function asCallResponseSpec(value: unknown): CallResponseSpec | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return compactDefined(
    callResponseSpecFields(value as Record<string, unknown>),
  );
}

function callResponseSkipValidation(
  source: Record<string, unknown>,
): boolean | undefined {
  return source.kind === "accepted" || source.kind === "rejected"
    ? undefined
    : optionalBoolean(source.skipValidation);
}

export function callResponseNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    ...callResponseSpecFields(nodeData as Record<string, unknown>),
    skipValidation: callResponseSkipValidation(
      nodeData as Record<string, unknown>,
    ),
  });
}

export function callResponseFormToNodeData(
  formData: NodeFormData,
): CallResponseNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    ...callResponseSpecFields(formData),
    skipValidation: callResponseSkipValidation(formData),
  }) as CallResponseNodeData;
}

const NOTIFY_KINDS_SET = new Set<string>(NOTIFY_KINDS);

function asNotifyKind(value: unknown): NotifyNodeData["kind"] {
  return NOTIFY_KINDS_SET.has(value as string)
    ? (value as NotifyNodeData["kind"])
    : "firmwareStatus";
}

/** A `{ "$from": "..." }` reference as written, or undefined. */
function asFromReference(value: unknown): { $from: string } | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $from?: unknown }).$from === "string"
    ? { $from: (value as { $from: string }).$from }
    : undefined;
}

function notifyFields(source: Record<string, unknown>) {
  const kind = asNotifyKind(source.kind);
  const status =
    typeof source.status === "string"
      ? source.status
      : NOTIFY_STATUSES[kind][0];
  return compactDefined({
    kind,
    status,
    requestId:
      optionalNumber(source.requestId) ?? asFromReference(source.requestId),
  });
}

export function notifyNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return {
    ...baseToForm(nodeData),
    ...notifyFields(nodeData as Record<string, unknown>),
  };
}

export function notifyFormToNodeData(formData: NodeFormData): NotifyNodeData {
  return {
    ...baseFromForm(formData),
    ...notifyFields(formData),
  } as NotifyNodeData;
}

export function switchNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<SwitchNodeData>;
  return {
    ...baseToForm(nodeData),
    value: data.value ?? null,
    // As the file has them, a list or not: the form says when they are
    // not and changes them only on the user's word.
    cases: data.cases,
  };
}

export function switchFormToNodeData(formData: NodeFormData): SwitchNodeData {
  return {
    ...baseFromForm(formData),
    value: formData.value ?? null,
    cases: formData.cases as unknown[],
  };
}

/** Keeps the options as authored: a finite weight and a label. An entry
 *  that is not an object (null, a number) stays as it is: the executor
 *  draws it with weight 1, and the form shows it as such. */
function choiceOptions(value: unknown): ChoiceNodeData["options"] {
  if (!Array.isArray(value)) return [];
  return value.map((option) => {
    if (
      typeof option !== "object" ||
      option === null ||
      Array.isArray(option)
    ) {
      return option as ChoiceNodeData["options"][number];
    }
    const o = option as {
      weight?: unknown;
      label?: unknown;
    };
    const weight = optionalNumber(o.weight);
    return compactDefined({
      weight,
      label:
        typeof o.label === "string" && o.label !== "" ? o.label : undefined,
    });
  });
}

export function choiceNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return {
    ...baseToForm(nodeData),
    options: choiceOptions((nodeData as Partial<ChoiceNodeData>).options),
  };
}

export function choiceFormToNodeData(formData: NodeFormData): ChoiceNodeData {
  return {
    ...baseFromForm(formData),
    options: choiceOptions(formData.options),
  };
}

export function setStateNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<SetStateNodeData>;
  return {
    ...baseToForm(nodeData),
    key: stringValue(data.key),
    value: data.value ?? null,
  };
}

export function setStateFormToNodeData(
  formData: NodeFormData,
): SetStateNodeData {
  return {
    ...baseFromForm(formData),
    key: stringValue(formData.key),
    value: formData.value ?? null,
  };
}

export function useBehaviorNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return {
    ...baseToForm(nodeData),
    behaviorId: stringValue(
      (nodeData as Partial<UseBehaviorNodeData>).behaviorId,
    ),
    ...compactDefined({
      mode: (nodeData as Partial<UseBehaviorNodeData>).mode,
      params: (nodeData as Partial<UseBehaviorNodeData>).params,
    }),
  };
}

export function useBehaviorFormToNodeData(
  formData: NodeFormData,
): UseBehaviorNodeData {
  return {
    ...baseFromForm(formData),
    behaviorId: stringValue(formData.behaviorId),
    // "use" is the default: only "disable" is written, and a disabled node
    // carries no params.
    ...(formData.mode === "disable"
      ? { mode: "disable" as const }
      : compactDefined({
          params:
            typeof formData.params === "object" &&
            formData.params !== null &&
            !Array.isArray(formData.params)
              ? (formData.params as Record<string, unknown>)
              : undefined,
        })),
  };
}

export function csmsCallTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    action: asCsmsCallTriggerAction(
      (nodeData as Partial<CsmsCallTriggerNodeData>).action,
    ),
    timeout: optionalNumber(
      (nodeData as Partial<CsmsCallTriggerNodeData>).timeout,
    ),
    payload: (nodeData as Partial<CsmsCallTriggerNodeData>).payload,
    behavior:
      (nodeData as Partial<CsmsCallTriggerNodeData>).behavior === "replace"
        ? "replace"
        : undefined,
    onBusy:
      (nodeData as Partial<CsmsCallTriggerNodeData>).behavior === "replace"
        ? asCallResponseSpec(
            (nodeData as Partial<CsmsCallTriggerNodeData>).onBusy,
          )
        : undefined,
  });
}

export function csmsCallTriggerFormToNodeData(
  formData: NodeFormData,
): CsmsCallTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: asCsmsCallTriggerAction(formData.action),
    timeout: optionalNumber(formData.timeout),
    payload: asPayloadCondition(formData.payload),
    // `observe` is the default and stays absent from saved scenarios.
    behavior: formData.behavior === "replace" ? "replace" : undefined,
    onBusy:
      formData.behavior === "replace"
        ? asCallResponseSpec(formData.onBusy)
        : undefined,
  }) as CsmsCallTriggerNodeData;
}

export function responseOverrideNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const action = asResponseOverrideAction(
    (nodeData as Partial<ResponseOverrideNodeData>).action,
  );
  return compactDefined({
    ...baseToForm(nodeData),
    action,
    status: asResponseOverrideStatus(
      (nodeData as Partial<ResponseOverrideNodeData>).status,
      action,
    ),
  });
}

export function responseOverrideFormToNodeData(
  formData: NodeFormData,
): ResponseOverrideNodeData {
  const action = asResponseOverrideAction(formData.action);
  return {
    ...baseFromForm(formData),
    action,
    status: asResponseOverrideStatus(formData.status, action),
  };
}

export function inboundPolicyNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<InboundPolicyNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: asInboundPolicyAction(data.action),
    policy: asInboundPolicyMode(data.policy),
    errorCode: asInboundPolicyErrorCode(data.errorCode),
    errorDescription: optionalString(data.errorDescription),
  });
}

export function inboundPolicyFormToNodeData(
  formData: NodeFormData,
): InboundPolicyNodeData {
  const policy = asInboundPolicyMode(formData.policy);
  return compactDefined({
    ...baseFromForm(formData),
    action: asInboundPolicyAction(formData.action),
    policy,
    ...(policy === "callerror"
      ? {
          errorCode: asInboundPolicyErrorCode(formData.errorCode),
          errorDescription: optionalString(formData.errorDescription),
        }
      : {}),
  }) as InboundPolicyNodeData;
}
