import type { ChargePointServiceFactories } from "../../domain/charge-point/ChargePointDeps";
import type {
  ChargePointTimeline,
  TimelineEntry,
} from "../../domain/services/ChargePointTimeline";

/**
 * Service replacements for a station nobody looks at: a load test runs
 * thousands of charge points in one process and reads neither the operational
 * timeline nor the state history, which cost ~50 heap objects per station
 * (measured on k6/Sobek: ~7 % of a connected station). Pass the result as the
 * `services` argument of `createChargePoint`.
 *
 * Opt-in only. A console or daemon station keeps the defaults; with these
 * `timeline.query()` is empty and `stateManager.history` has no entries.
 * Nothing on the wire changes: neither service sends or decides anything.
 */
export function createHeadlessServices(): Pick<
  ChargePointServiceFactories,
  "createTimeline" | "createStateManager"
> {
  const entry: TimelineEntry = {
    seq: 0,
    timestamp: "1970-01-01T00:00:00.000Z",
    kind: "status_change",
    cpId: "",
    summary: "",
    data: {},
  };
  const noop = (): void => undefined;
  const timeline: ChargePointTimeline = {
    startRun: noop,
    endRun: noop,
    record: () => entry,
    query: () => ({ entries: [], total: 0 }),
    onRecord: () => noop,
  };
  const projector = { dispose: noop };
  return {
    createTimeline: () => ({ timeline, projector }),
    createStateManager: ({ chargePoint }) => ({
      history: { getHistory: () => [] },
      transitionChargePointStatus: (status) => ({
        success: true,
        previousState: chargePoint().status,
        newState: status,
      }),
    }),
  };
}
