import type { BootNotification } from "../types/OcppTypes";
import type { CellularModem } from "./CellularModem";

/**
 * The modem identifiers a BootNotification carries (#929), from the one
 * domain state at the moment the message is prepared. Pure projection; the
 * version-specific serialization stays in the message handlers: 1.6 JSON and
 * SOAP put `iccid` / `imsi` at the root, 2.0.1 / 2.1 map them into
 * `chargingStation.modem` and omit `modem` when both are absent.
 *
 * - no modem, empty slot, or policy `none`: no identifier;
 * - policy `iccid`: the card's ICCID only;
 * - policy `iccid-and-imsi`: both, each only when the card has it.
 *
 * The subscription state plays no part: a suspended card keeps reporting.
 * An identifier the card does not have is never fabricated.
 */
export function projectBootIdentifiers(modem: CellularModem): {
  iccid?: string;
  imsi?: string;
} {
  const sim = modem.sim;
  if (!sim || modem.reporting === "none") return {};
  return {
    ...(sim.iccid !== undefined ? { iccid: sim.iccid } : {}),
    ...(modem.reporting === "iccid-and-imsi" && sim.imsi !== undefined
      ? { imsi: sim.imsi }
      : {}),
  };
}

/**
 * The BootNotification payload of a station.
 *
 * Without a modem model (`modem === null`, the legacy default) it is `base`
 * itself, the same object: its static `iccid` / `imsi` (including the empty
 * strings of the 1.6 golden fixtures) go out byte for byte as before.
 *
 * With a modem model the SIM is the single source of truth: `base`'s static
 * `iccid` / `imsi` are ignored (never merged), and the optional fields are
 * left out entirely when nothing is reported, instead of sending a
 * placeholder.
 */
export function bootNotificationFor(
  base: BootNotification,
  modem: CellularModem | null,
): BootNotification {
  if (!modem) return base;
  const { iccid: _staticIccid, imsi: _staticImsi, ...rest } = base;
  return { ...rest, ...projectBootIdentifiers(modem) };
}
