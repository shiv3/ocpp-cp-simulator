import { z } from "zod";

const pct = z.number().min(0).max(50).finite();

const sampledValueOverrideSchema = z
  .object({
    measurand: z.string().regex(/^[A-Za-z][A-Za-z.]*$/),
    phase: z.string().optional(),
    set: z
      .object({
        unit: z.string().optional(),
        multiplier: z.number().int().optional(),
        decimals: z.number().int().min(0).max(10).optional(),
        location: z.string().optional(),
        context: z.string().optional(),
        phase: z.string().optional(),
        value: z.string().optional(),
        omit: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/** Opt-in meter realism of one connector (#614-#616); see
 *  `MeterRealism` in `@ocpp-cp-sim/core`. */
export const meterRealismSchema = z
  .object({
    seed: z.number().int().optional(),
    fluctuation: z
      .object({
        voltagePct: pct.optional(),
        currentPct: pct.optional(),
        powerPct: pct.optional(),
      })
      .strict()
      .optional(),
    rampUp: z
      .object({
        shape: z.enum(["linear", "sigmoid"]),
        durationSeconds: z.number().positive().finite(),
      })
      .strict()
      .optional(),
    phases: z
      .object({
        voltageImbalancePct: pct.optional(),
        loadImbalancePct: pct.optional(),
        lineToLine: z.boolean().optional(),
      })
      .strict()
      .optional(),
    export: z
      .object({ powerW: z.number().positive().finite() })
      .strict()
      .optional(),
    sampledValues: z.array(sampledValueOverrideSchema).max(100).optional(),
  })
  .strict();

/** The station's main meter on connector 0 / EVSE 0 (#617). */
export const mainMeterSchema = z
  .object({
    baseLoadW: z.number().min(0).finite().optional(),
    voltageV: z.number().positive().finite().optional(),
    phases: z.union([z.literal(1), z.literal(3)]).optional(),
    seed: z.number().int().optional(),
    voltagePct: pct.optional(),
    sampledValues: z.array(sampledValueOverrideSchema).max(100).optional(),
  })
  .strict();

/**
 * What the charger hardware delivers (#327): the charger side of "vehicle
 * demand ∩ charger capability ∩ CSMS allocation". Per connector, in watts;
 * the station aggregate is deliberately not modelled (no power sharing).
 */
export const chargerCapabilitiesSchema = z
  .object({
    connectors: z
      .array(
        z
          .object({
            connectorId: z
              .number()
              .int()
              .min(1)
              .describe("1-based connector id, as on the wire"),
            maxDeliveryPowerW: z
              .number()
              .positive()
              .finite()
              .describe("Most the hardware delivers on this connector, watts"),
            meter: meterRealismSchema.optional(),
          })
          .strict(),
      )
      .max(1_000)
      .refine(
        (list) => new Set(list.map((c) => c.connectorId)).size === list.length,
        { message: "a connectorId appears twice" },
      ),
    mainMeter: mainMeterSchema.optional(),
  })
  .strict();

export type WireChargerCapabilities = z.infer<typeof chargerCapabilitiesSchema>;

/** The same shape read-only, for code that only carries it. */
export interface ReadonlyChargerCapabilities {
  readonly connectors: ReadonlyArray<{
    readonly connectorId: number;
    readonly maxDeliveryPowerW: number;
    readonly meter?: z.infer<typeof meterRealismSchema>;
  }>;
  readonly mainMeter?: z.infer<typeof mainMeterSchema>;
}
