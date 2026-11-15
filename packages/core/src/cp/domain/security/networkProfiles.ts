// OCPP 2.x network connection profiles: what SetNetworkProfile (2.0.1 / 2.1
// use case B09) validates and stores. Pure, apart from the in-memory store.
import { isValidBasicAuthPassword } from "./securityProfileChange";

/**
 * `NetworkConnectionProfileType`, the fields of both 2.0.1 and 2.1 (2.1 makes
 * `ocppVersion` optional and adds `identity` / `basicAuthPassword`).
 */
export interface NetworkConnectionProfile {
  readonly ocppVersion?: string;
  readonly ocppTransport: string;
  readonly ocppCsmsUrl: string;
  readonly messageTimeout: number;
  readonly securityProfile: number;
  readonly ocppInterface: string;
  readonly identity?: string;
  readonly basicAuthPassword?: string;
  /** `APNType` / `VPNType`, stored as received; not checked. */
  readonly apn?: object;
  readonly vpn?: object;
}

/**
 * The `configurationSlot` values the station has. The simulator does not
 * publish `OCPPCommCtrlr.NetworkConfigurationPriority` yet, so the slots are
 * a fixed range that covers both 0- and 1-based numbering.
 */
export const NETWORK_PROFILE_SLOT_MIN = 0;
export const NETWORK_PROFILE_SLOT_MAX = 9;

/** The `ocppVersion` values a 2.x station of the simulator can connect with
 *  (`OCPP201` and `OCPP21` exist only in the 2.1 enum). */
const SUPPORTED_OCPP_VERSIONS: ReadonlySet<string> = new Set([
  "OCPP20",
  "OCPP201",
  "OCPP21",
]);

/**
 * `statusInfo.reasonCode` values of a Rejected SetNetworkProfile, from the
 * reason code list of OCPP 2.1 Part 2 Appendices (also valid in 2.0.1, where
 * reasonCode is a free string).
 */
export const NETWORK_PROFILE_REASON = {
  invalidSlot: "InvalidConfSlot",
  invalidConf: "InvalidNetworkConf",
  invalidUrl: "InvalidURL",
  unsupported: "UnsupportedParam",
  noDowngrade: "NoSecurityDowngrade",
} as const;

export interface NetworkProfileCheckInput {
  readonly configurationSlot: number;
  readonly profile: NetworkConnectionProfile;
  /** `SecurityCtrlr.SecurityProfile`, the profile in force. */
  readonly currentSecurityProfile: number;
  /** `SecurityCtrlr.AllowSecurityProfileDowngrade`. */
  readonly allowSecurityProfileDowngrade: boolean;
}

export type NetworkProfileVerdict =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reasonCode: string;
      readonly additionalInfo: string;
    };

const reject = (
  reasonCode: string,
  additionalInfo: string,
): NetworkProfileVerdict => ({ accepted: false, reasonCode, additionalInfo });

/**
 * Whether the station accepts `profile` into `configurationSlot` (B09.FR.01:
 * a profile with invalid content is Rejected; B09.FR.02: a valid one is
 * stored and Accepted).
 *
 * - The slot must be one the station has.
 * - The station speaks OCPP-J 2.x only: `ocppTransport` JSON, `ocppVersion`
 *   OCPP20 / OCPP201 / OCPP21 (absent is allowed on 2.1).
 * - `ocppCsmsUrl` is a ws:// or wss:// URL without a query or fragment;
 *   profiles 2 and 3 run over TLS, so they need wss://.
 * - `securityProfile` 0-3; `messageTimeout` positive.
 * - A `basicAuthPassword` (2.1) is 16-40 printable characters (A00.FR.202).
 * - B09.FR.04 / A00.FR.005: a profile lower than the one in force is
 *   Rejected, unless `AllowSecurityProfileDowngrade` is true and the change
 *   is 3 → 2, the only downgrade that variable permits.
 */
export function checkNetworkProfile(
  input: NetworkProfileCheckInput,
): NetworkProfileVerdict {
  const { configurationSlot: slot, profile } = input;
  if (
    !Number.isInteger(slot) ||
    slot < NETWORK_PROFILE_SLOT_MIN ||
    slot > NETWORK_PROFILE_SLOT_MAX
  ) {
    return reject(
      NETWORK_PROFILE_REASON.invalidSlot,
      `configurationSlot ${slot} is not one of ${NETWORK_PROFILE_SLOT_MIN}-${NETWORK_PROFILE_SLOT_MAX}`,
    );
  }
  if (profile.ocppTransport !== "JSON") {
    return reject(
      NETWORK_PROFILE_REASON.unsupported,
      `ocppTransport ${profile.ocppTransport} is not supported; only JSON`,
    );
  }
  if (
    profile.ocppVersion !== undefined &&
    !SUPPORTED_OCPP_VERSIONS.has(profile.ocppVersion)
  ) {
    return reject(
      NETWORK_PROFILE_REASON.unsupported,
      `ocppVersion ${profile.ocppVersion} is not supported`,
    );
  }
  const next = profile.securityProfile;
  if (!Number.isInteger(next) || next < 0 || next > 3) {
    return reject(
      NETWORK_PROFILE_REASON.invalidConf,
      `securityProfile ${next} is not 0-3`,
    );
  }
  if (!Number.isInteger(profile.messageTimeout) || profile.messageTimeout < 1) {
    return reject(
      NETWORK_PROFILE_REASON.invalidConf,
      `messageTimeout ${profile.messageTimeout} is not a positive number of seconds`,
    );
  }
  let url: URL;
  try {
    url = new URL(profile.ocppCsmsUrl);
  } catch {
    return reject(
      NETWORK_PROFILE_REASON.invalidUrl,
      "ocppCsmsUrl is not a URL",
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return reject(
      NETWORK_PROFILE_REASON.invalidUrl,
      `ocppCsmsUrl scheme ${url.protocol} is not ws: or wss:`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    return reject(
      NETWORK_PROFILE_REASON.invalidUrl,
      "ocppCsmsUrl has a query or fragment",
    );
  }
  if (next >= 2 && url.protocol !== "wss:") {
    return reject(
      NETWORK_PROFILE_REASON.invalidConf,
      `securityProfile ${next} needs a wss:// ocppCsmsUrl`,
    );
  }
  if (
    profile.basicAuthPassword !== undefined &&
    !isValidBasicAuthPassword(profile.basicAuthPassword)
  ) {
    return reject(
      NETWORK_PROFILE_REASON.invalidConf,
      "basicAuthPassword is not 16-40 printable ASCII characters",
    );
  }
  const current = input.currentSecurityProfile;
  if (next < current) {
    const allowed =
      input.allowSecurityProfileDowngrade && current === 3 && next === 2;
    if (!allowed) {
      return reject(
        NETWORK_PROFILE_REASON.noDowngrade,
        input.allowSecurityProfileDowngrade
          ? `securityProfile ${current} may only be lowered to 2 (from 3)`
          : `securityProfile ${next} is lower than the profile in force (${current}) and AllowSecurityProfileDowngrade is false`,
      );
    }
  }
  return { accepted: true };
}

/**
 * The station's NetworkConnectionProfiles, by `configurationSlot`. In memory
 * only: a profile can hold secrets (basicAuthPassword, APN / VPN passwords),
 * which the state database never stores. Storing a profile does not change
 * the connection; a later Reset or NetworkConfigurationPriority change would
 * pick it up.
 */
export class NetworkProfileStore {
  private readonly _slots = new Map<number, NetworkConnectionProfile>();

  set(slot: number, profile: NetworkConnectionProfile): void {
    this._slots.set(slot, profile);
  }

  get(slot: number): NetworkConnectionProfile | undefined {
    return this._slots.get(slot);
  }

  /** The occupied slots, in ascending order. */
  slots(): number[] {
    return [...this._slots.keys()].sort((a, b) => a - b);
  }
}
