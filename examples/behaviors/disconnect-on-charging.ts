// A template behavior that misbehaves on purpose, for testing a CSMS:
//
//   - when a connector turns to Charging it waits a seeded 1 to 3 seconds and
//     then sends a frame that is not a valid OCPP-J message (so a strict CSMS
//     closes the connection, or answers with a CALLERROR). The station
//     reconnects by itself;
//   - every MeterValues the station sends reports `METER_OFFSET` more than
//     the real reading, through `beforeSend` (and is counted in `ctx.state`);
//   - it records how the CSMS answered, through the `callResult` hook.
//
//   ocpp-cp-sim --cp-id CP001 --ws-url ws://localhost:9000 \
//     --behavior examples/behaviors/disconnect-on-charging.ts
//
// Event hooks run after the turn that caused the event, in load order, and are
// not awaited; `beforeSend` is synchronous. See docs/concepts/charger-engine.md.
import type {
  Behavior,
  BehaviorContext,
} from "@ocpp-cp-simulator/contracts/behavior";

/** Added to every meter reading the station reports (Wh in the default unit). */
const METER_OFFSET = 1000;

interface SampledValue {
  value?: unknown;
  [key: string]: unknown;
}

interface MeterValue {
  sampledValue?: SampledValue[];
  [key: string]: unknown;
}

export const disconnectOnCharging: Behavior = {
  api: 1,
  id: "disconnect-on-charging",
  requires: ["raw-frames"],
  on: {
    async connectorStatus(event, ctx: BehaviorContext) {
      if (event.to !== "Charging") return;
      await ctx.sleep(ctx.random("misbehave").int(1000, 3000));
      if (ctx.stopping) return;
      ctx.log(`connector ${event.connectorId} is charging: sending garbage`);
      // Not a valid OCPP-J frame: a message type that does not exist.
      ctx.raw(JSON.stringify([9, "misbehave", "NoSuchAction", {}]));
      ctx.state.misbehaved = Number(ctx.state.misbehaved ?? 0) + 1;
    },
    callResult(event, ctx) {
      if (event.outcome === "error") {
        ctx.state.lastError = event.action;
      }
    },
  },
  beforeSend: {
    MeterValues(payload, ctx) {
      const meterValue = (payload.meterValue as MeterValue[] | undefined) ?? [];
      const shifted = meterValue.map((mv) => ({
        ...mv,
        sampledValue: (mv.sampledValue ?? []).map((sv) =>
          // Only the energy register; a voltage or a current is left alone.
          sv.measurand === undefined ||
          sv.measurand === "Energy.Active.Import.Register"
            ? { ...sv, value: String(Number(sv.value) + METER_OFFSET) }
            : sv,
        ),
      }));
      ctx.state.meterValuesAltered =
        Number(ctx.state.meterValuesAltered ?? 0) + 1;
      return { ...payload, meterValue: shifted };
    },
  },
};

export default disconnectOnCharging;
