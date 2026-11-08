// Per-charge-point transport settings (#609): the one shape `cp.create`'s
// `transport` parameter, the CLI flags and the daemon's stored
// `charge_points.transport_options` agree on. Documented in
// `docs/concepts/control-plane.md` and `docs/entities/cli.md`.

import { z } from "zod";

const count = (what: string) =>
  z.number().int().min(-1).describe(`${what} -1 = unlimited, 0 = none.`);

export const reconnectConfigSchema = z
  .object({
    maxAttempts: count(
      "Reconnect attempts after a connection loss before giving up.",
    ).optional(),
    mode: z
      .enum(["exponential", "fixed"])
      .optional()
      .describe(
        '"exponential" (default) doubles the delay every attempt up to maxDelayMs, "fixed" waits baseDelayMs every time. A 2.x charge point follows OCPPCommCtrlr RetryBackOffWaitMinimum / RandomRange / RepeatTimes instead of baseDelayMs / jitterMs',
      ),
    baseDelayMs: z
      .number()
      .min(0)
      .max(2_147_483_647)
      .optional()
      .describe("Delay before the first attempt in ms (default 1000)."),
    maxDelayMs: z
      .number()
      .min(0)
      .max(2_147_483_647)
      .optional()
      .describe("Cap of the exponential delay in ms (default 30000)."),
    jitterMs: z
      .number()
      .min(0)
      .max(2_147_483_647)
      .optional()
      .describe(
        "A random extra delay in [0, jitterMs] ms from the charge point's seeded stream (default 0).",
      ),
    bootRetryLimit: count(
      "Automatic BootNotification re-sends after a Rejected answer before stopping.",
    ).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.baseDelayMs === undefined ||
      v.maxDelayMs === undefined ||
      v.maxDelayMs >= v.baseDelayMs,
    { message: "maxDelayMs must be >= baseDelayMs" },
  );

export const transportConfigSchema = z
  .object({
    reconnect: reconnectConfigSchema.optional(),
  })
  .strict();

export type TransportConfigWire = z.infer<typeof transportConfigSchema>;
