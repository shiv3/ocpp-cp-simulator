import {
  ModemError,
  type CellularModem,
  type ModemErrorCode,
  type NetworkInterface,
  type RedactedModemState,
  type SimCardInit,
} from "./CellularModem";

/** One lifecycle command, as `modem.command` carries it (#928). */
export interface ModemCommandInput {
  readonly command:
    | "insert_sim"
    | "remove_sim"
    | "replace_sim"
    | "suspend_subscription"
    | "activate_subscription"
    | "set_network_interface";
  /** The card, for `insert_sim` and `replace_sim`. */
  readonly sim?: SimCardInit;
  /** For `set_network_interface`. */
  readonly networkInterface?: NetworkInterface;
}

export type ModemCommandResult =
  | { ok: true; modem: RedactedModemState }
  | { ok: false; error: ModemErrorCode | "no_modem_model" };

function requireSim(input: ModemCommandInput): SimCardInit {
  if (input.sim === undefined) {
    throw new ModemError("invalid_sim", `${input.command} needs a sim`);
  }
  return input.sim;
}

/**
 * Run a command against a charge point's modem. A station without a modem
 * model refuses every command with `no_modem_model`; a refused transition
 * leaves the state as it was and answers its typed code. The answer carries
 * the masked state, never the full identifiers.
 */
export function runModemCommand(
  modem: CellularModem | null,
  input: ModemCommandInput,
): ModemCommandResult {
  if (!modem) return { ok: false, error: "no_modem_model" };
  try {
    switch (input.command) {
      case "insert_sim":
        modem.insertSim(requireSim(input));
        break;
      case "remove_sim":
        modem.removeSim();
        break;
      case "replace_sim":
        modem.replaceSim(requireSim(input));
        break;
      case "suspend_subscription":
        modem.suspendSubscription();
        break;
      case "activate_subscription":
        modem.activateSubscription();
        break;
      case "set_network_interface":
        modem.setNetworkInterface(input.networkInterface as NetworkInterface);
        break;
    }
    return { ok: true, modem: modem.redacted() };
  } catch (err) {
    if (err instanceof ModemError) return { ok: false, error: err.code };
    throw err;
  }
}
