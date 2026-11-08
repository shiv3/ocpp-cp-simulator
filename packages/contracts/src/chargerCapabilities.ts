import { z } from "zod";

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
          })
          .strict(),
      )
      .max(1_000)
      .refine(
        (list) => new Set(list.map((c) => c.connectorId)).size === list.length,
        { message: "a connectorId appears twice" },
      ),
  })
  .strict();

export type WireChargerCapabilities = z.infer<typeof chargerCapabilitiesSchema>;

/** The same shape read-only, for code that only carries it. */
export interface ReadonlyChargerCapabilities {
  readonly connectors: ReadonlyArray<{
    readonly connectorId: number;
    readonly maxDeliveryPowerW: number;
  }>;
}
