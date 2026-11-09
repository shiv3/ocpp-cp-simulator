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
 *  `MeterRealism` in `@ocpp-cp-simulator/core`. */
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

/** How the station divides one power budget between its connectors (#608). */
export const powerSharingSchema = z
  .object({
    totalPowerW: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe("The station's total power in watts"),
    strategy: z
      .enum(["equal", "active"])
      .optional()
      .describe(
        "equal: split between all connectors; active: between the connectors with a running transaction (default equal)",
      ),
    currentLimit: z
      .object({
        key: z.string().min(1).max(50),
        valueA: z.number().positive().finite(),
        voltageV: z.number().positive().finite().optional(),
        phases: z.union([z.literal(1), z.literal(3)]).optional(),
      })
      .strict()
      .optional()
      .describe(
        "A non-standard configuration key carrying the station current limit in amperes; ChangeConfiguration on it changes the budget",
      ),
  })
  .strict()
  .refine((v) => v.totalPowerW !== undefined || v.currentLimit !== undefined, {
    message: "powerSharing needs totalPowerW or currentLimit",
  });

/**
 * What the charger hardware delivers (#327): the charger side of "vehicle
 * demand ∩ charger capability ∩ CSMS allocation". Per connector, in watts;
 * the station aggregate is `powerSharing` (#608), absent by default.
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
            dcEfficiency: z
              .number()
              .gt(0)
              .max(1)
              .optional()
              .describe(
                "DC conversion efficiency; the grid-side meter reads the input",
              ),
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
    powerSharing: powerSharingSchema.optional(),
  })
  .strict();

export type WireChargerCapabilities = z.infer<typeof chargerCapabilitiesSchema>;

/** The same shape read-only, for code that only carries it. */
export interface ReadonlyChargerCapabilities {
  readonly connectors: ReadonlyArray<{
    readonly connectorId: number;
    readonly maxDeliveryPowerW: number;
    readonly dcEfficiency?: number;
    readonly meter?: z.infer<typeof meterRealismSchema>;
  }>;
  readonly mainMeter?: z.infer<typeof mainMeterSchema>;
  readonly powerSharing?: z.infer<typeof powerSharingSchema>;
}
