// A template behavior: UpdateFirmware that downloads and installs in a few
// steps and, with a seeded probability, fails the install. Copy it, rename the
// id, change the story.
//
//   ocpp-cp-sim --cp-id CP001 --ws-url ws://localhost:9000 \
//     --behavior examples/behaviors/flaky-firmware.ts
//
// Rules a behavior follows (the ESLint config in
// `@ocpp-cp-simulator/contracts/eslint-behavior` enforces them):
//   - waits go through ctx.sleep, draws through ctx.random, instants through
//     ctx.now;
//   - user data lives in ctx.state (JSON only), never at module scope;
//   - no `for await`, async generators or `using` (they hang on k6).
import type {
  Behavior,
  BehaviorContext,
} from "@ocpp-cp-simulator/contracts/behavior";

/** Chance, per update, that the install fails. */
const FAILURE_RATE = 0.3;

async function report(
  ctx: BehaviorContext,
  requestId: number | undefined,
  plan: ReadonlyArray<readonly [string, number]>,
): Promise<void> {
  for (const [status, delayMs] of plan) {
    await ctx.sleep(delayMs);
    if (ctx.stopping) return;
    ctx.notify.firmwareStatus(status, { requestId });
    ctx.state.lastStatus = status;
  }
}

export const flakyFirmware: Behavior = {
  api: 1,
  id: "flaky-firmware",
  onCall: {
    UpdateFirmware: {
      mode: "replace",
      handle(req, ctx) {
        const { requestId } = req as { requestId?: number };
        const attempts = Number(ctx.state.attempts ?? 0) + 1;
        ctx.state.attempts = attempts;
        const draws = ctx.random("flaky-firmware");
        const fails = draws.next() < FAILURE_RATE;
        const plan: Array<readonly [string, number]> = [
          ["Downloading", 500],
          ["Downloaded", draws.int(1000, 3000)],
          ["Installing", 500],
          [fails ? "InstallationFailed" : "Installed", draws.int(2000, 5000)],
        ];
        // `{}` on 1.6, `{ status: "Accepted" }` on 2.x.
        return {
          response: ctx.accepted("UpdateFirmware"),
          after: () => report(ctx, requestId, plan),
        };
      },
    },
  },
};

export default flakyFirmware;
