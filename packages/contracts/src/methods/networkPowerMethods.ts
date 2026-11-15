import { z } from "zod";
import { OBJ_MAX_BYTES, STR_64K, boundedObject } from "../limits";
import { modemCommandSchema } from "../modem";
import { EMPTY, ANY } from "../schemas/common";

/** An outage of up to a week. */
const POWER_OUTAGE_MAX_MS = 7 * 24 * 3600 * 1000;

const powerRecoveryShape = {
  transactions: z
    .enum(["resume", "end"])
    .optional()
    .describe(
      "What happens to the interrupted transactions after the reboot. Default: resume (1.x, 2.1), end (2.0.1)",
    ),
  txResumptionTimeoutSeconds: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .describe(
      "OCPP 2.1 TxResumptionTimeout: resume only when the outage lasted at most this long; absent or 0: end (E17.FR.01)",
    ),
};

export const NETWORK_POWER_METHODS = {
  // -- cellular modem and SIM (#928) --
  "modem.get": { params: z.object({ cpId: STR_64K }), result: ANY },
  "modem.command": { params: modemCommandSchema, result: ANY },

  // -- network simulation --
  "network_sim.global.get": { params: EMPTY, result: ANY },
  "network_sim.global.save": {
    params: z.object({ config: boundedObject(OBJ_MAX_BYTES).nullable() }),
    result: ANY,
  },
  "network_sim.cp.get": {
    params: z.object({ cpId: STR_64K }),
    result: ANY,
  },
  "network_sim.cp.save": {
    params: z.object({
      cpId: STR_64K,
      config: boundedObject(OBJ_MAX_BYTES).nullable(),
    }),
    result: ANY,
  },
  // #930: SIM-scoped cellular policies (`online | blocked`, byte caps), by
  // simId / ICCID / operator. Persisted; apply to every charge point, also to
  // ones that acquire a matching SIM or are created later.
  "network_sim.cellular.get": { params: EMPTY, result: ANY },
  "network_sim.cellular.save": {
    params: z.object({
      policies: boundedObject(OBJ_MAX_BYTES)
        .nullable()
        .describe(
          "Policy id -> { match: { simId | iccid | operator }, service?: online|blocked, upstreamBytesPerSecond?, downstreamBytesPerSecond?, enabled? }; replaces the whole set, null clears it",
        ),
    }),
    result: ANY,
  },
  "network_sim.cellular.status": { params: EMPTY, result: ANY },
  "network_sim.disconnect.trigger": {
    params: z.object({ cpId: STR_64K, ruleId: STR_64K }),
    result: ANY,
  },

  // #455: a power loss is neither a network loss nor an OCPP Reset. Answers
  // `{ ok: true, ... }` or `{ ok: false, error }` (`cp_not_found`,
  // `already_powered_off`, `not_powered_off`, `unsupported_transport` for an
  // OCPP-S (SOAP) charge point). Commands that start or stop a transaction
  // fail with `powered_off` while the station has no power.
  "power.loss": {
    params: z.object({
      cpId: STR_64K,
      restoreAfterMs: z
        .number()
        .int()
        .min(0)
        .max(POWER_OUTAGE_MAX_MS)
        .optional()
        .describe(
          "Outage length; power returns by itself after it. Absent: off until power.restore",
        ),
      ...powerRecoveryShape,
    }),
    result: ANY,
  },
  "power.restore": {
    params: z.object({ cpId: STR_64K, ...powerRecoveryShape }),
    result: ANY,
  },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
