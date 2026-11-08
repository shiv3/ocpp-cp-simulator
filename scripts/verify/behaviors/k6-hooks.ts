// Checks, on a real k6, the parts of the behavior API stage E added that the
// k6 host provides: event hooks (connected, callResult, callReceived),
// beforeSend (a rewrite and a drop) and ctx.accepted. Used by the stage E
// verification in docs/concepts/charger-engine.md:
//
//   bun apps/cli/src/main.ts export-k6 --behavior scripts/verify/behaviors/k6-hooks.ts -o /tmp/k6hooks
//   bun scripts/verify/fakeCsms16.ts --port 9100 --log /tmp/frames.jsonl --update-firmware &
//   CSMS_URL=ws://127.0.0.1:9100 VUS=1 DURATION=12s RUN_FOR_MS=6000 k6 run /tmp/k6hooks/behavior.k6.ts
//
// Expected on the CSMS: UpdateFirmware answered `{}`, then Downloading,
// Installing and Installed with requestId 42, and no Downloaded (dropped).
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";

const behavior: Behavior = {
  api: 1,
  id: "k6-hooks",
  on: {
    connected: (_e, ctx) => {
      ctx.log("hook: connected");
    },
    callReceived: (e, ctx) => {
      ctx.log(`hook: received ${e.action}`);
    },
    callResult: (e, ctx) => {
      if (e.action === "FirmwareStatusNotification") {
        ctx.state.answered = Number(ctx.state.answered ?? 0) + 1;
        ctx.log(`hook: ${e.action} answered ${e.outcome}`);
      }
    },
  },
  beforeSend: {
    FirmwareStatusNotification: (payload, ctx) => {
      if (payload.status === "Downloaded") {
        ctx.log("beforeSend: dropping Downloaded");
        return { drop: true };
      }
      return { ...payload, requestId: 42 };
    },
  },
  onCall: {
    UpdateFirmware: {
      mode: "replace",
      handle: (_req, ctx) => ({
        response: ctx.accepted("UpdateFirmware"),
        after: async () => {
          for (const status of [
            "Downloading",
            "Downloaded",
            "Installing",
            "Installed",
          ]) {
            await ctx.sleep(300);
            ctx.notify.firmwareStatus(status);
          }
        },
      }),
    },
  },
};

export default behavior;
