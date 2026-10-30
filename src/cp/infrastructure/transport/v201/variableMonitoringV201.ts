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
import type { DeviceModelContext } from "./getVariablesV201";
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
import { resolveDeviceModelVariable } from "./deviceModelMap";
import { MONITORING_ITEMS_PER_PART, splitIntoParts } from "./reportParts";
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
  IntervalTooShort: "a Periodic interval is at least 1 second",
  NegativeTargetDelta: "a TargetDelta value cannot be negative",
};

export function handleSetVariableMonitoringV201(
  req: SetVariableMonitoringRequestV201,
  monitoring: MonitoringStore,
  configuration: ConfigurationStore,
  { evseExists = () => false, targets }: DeviceModelContext,
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

    // N04.FR.03: a component is its name plus its EVSE scope, so an EVSE
    // (or a connector on it) the station does not have is unknown too.
    // An EVSE-scoped component (#538) also needs an EVSE (below).
    if (data.component.evse !== undefined && !evseExists(data.component.evse)) {
      return { status: "UnknownComponent", ...echo };
    }
    const resolved = resolveDeviceModelVariable(
      data.component,
      data.variable,
      evseExists,
    );
    if (resolved.status !== "Found") {
      return { status: resolved.status, ...echo }; // N04.FR.03, FR.04
    }
    const { valueKey } = resolved;
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
      valueType: {
        ...valueTypeOf(entry.key),
        // 2.1 TargetDelta monitors need a Target attribute (#538).
        ...(targets?.supports(valueKey) === true && { hasTarget: true }),
      },
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
  PeriodicMonitoring: ["Periodic", "PeriodicClockAligned"], // N02.FR.14
};

export interface MonitoringReport {
  readonly response: GetMonitoringReportResponseV201;
  /** The NotifyMonitoringReport parts to send, in order, after an Accepted
   *  response; empty otherwise. */
  readonly reports: readonly NotifyMonitoringReportPayload[];
}

export function buildMonitoringReportV201(
  req: GetMonitoringReportRequestV201,
  monitoring: MonitoringStore,
  dialect: MonitoringReportDialect,
  itemsPerPart: number = MONITORING_ITEMS_PER_PART,
): MonitoringReport {
  let types: Set<SupportedMonitorType> | undefined;
  if (req.monitoringCriteria !== undefined) {
    types = new Set(req.monitoringCriteria.flatMap((c) => CRITERION_TYPES[c]));
    // N02.FR.02: every requested criterion is one the station lacks.
    if (types.size === 0) {
      return { response: { status: "NotSupported" }, reports: [] };
    }
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
    // N02.FR.10
    return { response: { status: "EmptyResultSet" }, reports: [] };
  }

  // N02.FR.03 / FR.04 / FR.09: one or more parts with the request's
  // requestId, seqNo from 0 and tbc on every part but the last (#538). A
  // component/variable group is never split across two parts.
  const generatedAt = new Date().toISOString();
  return {
    response: { status: "Accepted" }, // N02.FR.01
    reports: splitIntoParts([first, ...monitor.slice(1)], itemsPerPart).map(
      ({ items, seqNo, tbc }) =>
        ({
          requestId: req.requestId,
          generatedAt,
          seqNo,
          tbc,
          monitor: [...items],
        }) as NotifyMonitoringReportPayload,
    ),
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
      // The 2.1 TargetDelta types only exist on a 2.1 station: the 2.0.1
      // schema refuses them in SetVariableMonitoring.
      type: m.type as VariableMonitoringEntry["type"],
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
    const { response, reports } = buildMonitoringReportV201(
      payload as GetMonitoringReportRequestV201,
      ctx.chargePoint.monitoring,
      dialect,
    );
    return reports.length === 0
      ? { response }
      : {
          response,
          afterResult: () => {
            for (const report of reports) {
              ctx.sendCall("NotifyMonitoringReport", report);
            }
          },
        };
  };
}
