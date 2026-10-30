// OCPP 2.0.1 / 2.1 variable monitoring handlers (N02, N04, N05, N06) on the
// charge point's MonitoringStore. Component/variable resolution goes through
// the same device-model map as GetVariables / SetVariables.
import type {
  ClearVariableMonitoringRequestV201,
  ClearVariableMonitoringResponseV201,
  GetMonitoringReportRequestV201,
  GetMonitoringReportResponseV201,
  NotifyMonitoringReportRequestV201,
  NotifyMonitoringReportRequestV21,
  SetMonitoringLevelRequestV201,
  SetMonitoringLevelResponseV201,
  SetVariableMonitoringRequestV201,
  SetVariableMonitoringResponseV201,
} from "../../../../ocpp";
import type { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import type {
  InstallOutcome,
  InstallRejectionReason,
  MonitoringStore,
} from "../../../domain/monitoring/MonitoringStore";
import { selectMonitors } from "../../../domain/monitoring/selectMonitors";
import {
  sameMonitorTarget,
  type MonitoredValueType,
  type SupportedMonitorType,
  type VariableMonitor,
} from "../../../domain/monitoring/VariableMonitor";
import { KNOWN_V201_COMPONENTS, lookupV16Key } from "./deviceModelMap";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";

type SetMonitoringResult =
  SetVariableMonitoringResponseV201["setMonitoringResult"][number];
type ClearMonitoringResult =
  ClearVariableMonitoringResponseV201["clearMonitoringResult"][number];
type MonitoringCriterion = NonNullable<
  GetMonitoringReportRequestV201["monitoringCriteria"]
>[number];

/** Which NotifyMonitoringReport shape to build (2.1 adds a required field). */
export type MonitoringReportDialect = "v201" | "v21";

export type NotifyMonitoringReportPayload =
  NotifyMonitoringReportRequestV201 | NotifyMonitoringReportRequestV21;

const REJECTION_INFO: Record<InstallRejectionReason, string> = {
  UnknownMonitorId: "N04.FR.13: no monitor exists with this id",
  TargetMismatch:
    "N04.FR.16: a monitor's component and variable cannot be changed",
  HardWiredMonitor: "N04.FR.18: a hardwired monitor cannot be replaced",
  ValueOutOfRange: "N04.FR.06: threshold is outside the variable's range",
  NegativeDelta: "N04.FR.14: a Delta value cannot be negative",
  SeverityOutOfRange: "severity range is 0-9",
};

export function handleSetVariableMonitoringV201(
  req: SetVariableMonitoringRequestV201,
  monitoring: MonitoringStore,
  configuration: ConfigurationStore,
): SetVariableMonitoringResponseV201 {
  // N04.FR.01 / FR.02: one result per item, echoing its target. Items are
  // applied in order, so a later item sees the monitors of earlier ones.
  const results = req.setMonitoringData.map((data): SetMonitoringResult => {
    const echo = {
      type: data.type,
      severity: data.severity,
      component: data.component,
      variable: data.variable,
    };

    if (!KNOWN_V201_COMPONENTS.has(data.component.name)) {
      return { status: "UnknownComponent", ...echo }; // N04.FR.03
    }
    const valueKey = lookupV16Key(data.component.name, data.variable.name);
    if (valueKey === undefined) {
      return { status: "UnknownVariable", ...echo }; // N04.FR.04
    }
    const entry = configuration.get(valueKey);
    if (entry === undefined) {
      // Same answer as GetVariables for a mapped key the store lacks.
      return { status: "Rejected", ...echo };
    }

    const outcome = monitoring.install({
      ...(data.id !== undefined && { id: data.id }),
      type: data.type,
      severity: data.severity,
      value: data.value,
      ...(data.transaction !== undefined && {
        transaction: data.transaction,
      }),
      component: data.component,
      variable: data.variable,
      valueKey,
      valueType: valueTypeOf(entry.key),
    });
    return toSetMonitoringResult(outcome, echo);
  });

  return {
    setMonitoringResult: results as [
      SetMonitoringResult,
      ...SetMonitoringResult[],
    ],
  };
}

function valueTypeOf(key: {
  type: string;
  min?: number;
  max?: number;
}): MonitoredValueType {
  if (key.type !== "integer") return { numeric: false };
  return {
    numeric: true,
    ...(key.min !== undefined && { min: key.min }),
    ...(key.max !== undefined && { max: key.max }),
  };
}

function toSetMonitoringResult(
  outcome: InstallOutcome,
  echo: Omit<SetMonitoringResult, "status" | "id" | "statusInfo">,
): SetMonitoringResult {
  switch (outcome.status) {
    case "Accepted":
      // N04.FR.08 / FR.11: the (generated or replaced) id goes back.
      return { id: outcome.monitor.id, status: "Accepted", ...echo };
    case "Duplicate":
      return { status: "Duplicate", ...echo }; // N04.FR.10
    case "UnsupportedMonitorType":
      return { status: "UnsupportedMonitorType", ...echo }; // N04.FR.05
    case "Rejected":
      return {
        status: "Rejected",
        ...echo,
        statusInfo: {
          reasonCode: outcome.reason,
          additionalInfo: REJECTION_INFO[outcome.reason],
        },
      };
  }
}

export function handleClearVariableMonitoringV201(
  req: ClearVariableMonitoringRequestV201,
  monitoring: MonitoringStore,
): ClearVariableMonitoringResponseV201 {
  // N06.FR.05: one result per id; N06.FR.01-FR.03 per status.
  const results = req.id.map((id): ClearMonitoringResult => ({
    id,
    status: monitoring.clear(id),
  }));
  return {
    clearMonitoringResult: results as [
      ClearMonitoringResult,
      ...ClearMonitoringResult[],
    ],
  };
}

export function handleSetMonitoringLevelV201(
  req: SetMonitoringLevelRequestV201,
  monitoring: MonitoringStore,
): SetMonitoringLevelResponseV201 {
  // N05.FR.01 / FR.02. The schemas only set a minimum; 0-9 is the range.
  return {
    status: monitoring.setMonitoringLevel(req.severity)
      ? "Accepted"
      : "Rejected",
  };
}

const CRITERION_TYPES: Record<
  MonitoringCriterion,
  readonly SupportedMonitorType[]
> = {
  ThresholdMonitoring: ["UpperThreshold", "LowerThreshold"], // N02.FR.12
  DeltaMonitoring: ["Delta"], // N02.FR.13
  // N02.FR.14: Periodic monitors are not implemented, so none can match.
  PeriodicMonitoring: [],
};

export interface MonitoringReport {
  readonly response: GetMonitoringReportResponseV201;
  /** The NotifyMonitoringReport to send after an Accepted response. */
  readonly report?: NotifyMonitoringReportPayload;
}

export function buildMonitoringReportV201(
  req: GetMonitoringReportRequestV201,
  monitoring: MonitoringStore,
  dialect: MonitoringReportDialect,
): MonitoringReport {
  let types: Set<SupportedMonitorType> | undefined;
  if (req.monitoringCriteria !== undefined) {
    types = new Set(req.monitoringCriteria.flatMap((c) => CRITERION_TYPES[c]));
    // N02.FR.02: every requested criterion is one the station lacks.
    if (types.size === 0) return { response: { status: "NotSupported" } };
  }

  const selected = selectMonitors(monitoring.list(), {
    ...(types !== undefined && { types }),
    ...(req.componentVariable !== undefined && {
      targets: req.componentVariable,
    }),
  });
  const monitor = groupByTarget(selected, dialect);
  const first = monitor[0];
  if (first === undefined) {
    return { response: { status: "EmptyResultSet" } }; // N02.FR.10
  }

  // N02.FR.03 / FR.04 / FR.09: one message (GetBaseReport does not split
  // either), the request's requestId, seqNo 0.
  return {
    response: { status: "Accepted" }, // N02.FR.01
    report: {
      requestId: req.requestId,
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      monitor: [first, ...monitor.slice(1)],
    } as NotifyMonitoringReportPayload,
  };
}

type MonitoringData = NonNullable<
  NotifyMonitoringReportRequestV201["monitor"]
>[number];
type VariableMonitoringEntry = MonitoringData["variableMonitoring"][number];

function groupByTarget(
  monitors: readonly VariableMonitor[],
  dialect: MonitoringReportDialect,
): MonitoringData[] {
  const groups: {
    target: VariableMonitor;
    entries: VariableMonitoringEntry[];
  }[] = [];
  for (const m of monitors) {
    const entry: VariableMonitoringEntry = {
      id: m.id,
      transaction: m.transaction,
      value: m.value,
      type: m.type,
      severity: m.severity,
      // 2.1 N02.FR.22; the 2.0.1 schema forbids the field.
      ...(dialect === "v21" && { eventNotificationType: m.origin }),
    };
    const group = groups.find((g) => sameMonitorTarget(g.target, m));
    if (group) group.entries.push(entry);
    else groups.push({ target: m, entries: [entry] });
  }
  return groups.map(({ target, entries }) => ({
    component: target.component,
    variable: target.variable,
    variableMonitoring: entries as [
      VariableMonitoringEntry,
      ...VariableMonitoringEntry[],
    ],
  }));
}

/** GetMonitoringReport: answer, then send the report (GetBaseReport pattern). */
export function createGetMonitoringReportHandlerV201(
  dialect: MonitoringReportDialect,
): (payload: unknown, ctx: V201InboundContext) => V201HandlerResult {
  return (payload, ctx) => {
    const { response, report } = buildMonitoringReportV201(
      payload as GetMonitoringReportRequestV201,
      ctx.chargePoint.monitoring,
      dialect,
    );
    return report === undefined
      ? { response }
      : {
          response,
          afterResult: () => ctx.sendCall("NotifyMonitoringReport", report),
        };
  };
}
