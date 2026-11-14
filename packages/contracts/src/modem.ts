import { z } from "zod";

/** Longest ICCID / IMSI OCPP BootNotification can carry. */
const IDENTIFIER = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[\x21-\x7e]+$/, "printable characters without spaces");

export const simCardInitSchema = z
  .object({
    iccid: IDENTIFIER.optional(),
    imsi: IDENTIFIER.optional(),
    operator: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x21-\x7e][\x20-\x7e]*$/)
      .optional()
      .describe("Operator label, also the key of operator-scoped policies"),
    subscription: z.enum(["active", "suspended"]).optional(),
  })
  .strict();

export const networkInterfaceSchema = z.enum(["ethernet", "wifi", "cellular"]);

/** `modem` in cp.create / blueprints (#928). */
export const modemConfigSchema = z
  .object({
    present: z
      .boolean()
      .optional()
      .describe("Default true; false: the station has no cellular modem"),
    networkInterface: networkInterfaceSchema
      .optional()
      .describe(
        "Path to the CSMS; default ethernet. Only cellular depends on the SIM",
      ),
    sim: simCardInitSchema
      .nullable()
      .optional()
      .describe("Card in the slot at start; absent or null: empty slot"),
  })
  .strict();

/** `modem.command` (#928): one lifecycle command on a charge point's modem. */
export const MODEM_COMMANDS = [
  "insert_sim",
  "remove_sim",
  "replace_sim",
  "suspend_subscription",
  "activate_subscription",
  "set_network_interface",
] as const;

export const modemCommandSchema = z
  .object({
    cpId: z.string().min(1).max(65536),
    command: z.enum(MODEM_COMMANDS),
    sim: simCardInitSchema
      .optional()
      .describe("The card, for insert_sim and replace_sim"),
    networkInterface: networkInterfaceSchema
      .optional()
      .describe("For set_network_interface"),
  })
  .strict();
export type ModemCommand = z.infer<typeof modemCommandSchema>;
