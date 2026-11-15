/**
 * The firmware version a simulated update installs (`bumpVersion` param of
 * `default.firmware` / `default.signedFirmware`, docs/entities/default-behaviors.md).
 *
 * A CSMS that rolls firmware out compares the `firmwareVersion` of the
 * BootNotification the station sends after the update (OCPP 1.6 §4.2
 * BootNotification.req, 2.0.1 B01 / L01 with reason FirmwareUpdate) with what
 * it rolled out. The simulator has no binary, so the new version is derived
 * from the request's `location`, and failing that from the current version.
 */

/** BootNotification `firmwareVersion` length: 1.6 CiString50Type, 2.x string(50). */
export const FIRMWARE_VERSION_MAX_LENGTH = 50;

/** A version-like token: `2.3.1`, `1.4.0-rc1`, `10.2+build.7`. */
const VERSION_TOKEN = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * Archive / image extensions stripped from the end of the file name, as often
 * as they occur (`.tar.gz` is `.gz` then `.tar`). Case-insensitive.
 */
const FIRMWARE_FILE_EXTENSIONS = [
  "bin",
  "img",
  "hex",
  "fw",
  "dfu",
  "elf",
  "swu",
  "pkg",
  "deb",
  "rpm",
  "ipk",
  "zip",
  "tar",
  "tgz",
  "gz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "sig",
  "signed",
] as const;

const EXTENSION = new RegExp(
  `\\.(?:${FIRMWARE_FILE_EXTENSIONS.join("|")})$`,
  "i",
);

/**
 * The file name of `location`: query and fragment removed, then the last
 * non-empty path segment, then the known extensions stripped.
 */
export function firmwareFileStem(location: string): string {
  const path = location.replace(/[?#].*$/s, "");
  const segments = path.split("/").filter((segment) => segment !== "");
  let stem = segments.length > 0 ? segments[segments.length - 1] : "";
  while (EXTENSION.test(stem)) stem = stem.replace(EXTENSION, "");
  return stem;
}

/**
 * The current version plus one: the trailing number incremented, keeping its
 * width when it had leading zeros (`1.0` → `1.1`, `fw-7` → `fw-8`,
 * `2.0.9` → `2.0.10`, `fw-007` → `fw-008`); without a trailing number `.1` is
 * appended (`beta` → `beta.1`); an empty version becomes `1`.
 */
export function incrementFirmwareVersion(current: string): string {
  if (current === "") return "1";
  const match = /(\d+)$/.exec(current);
  if (!match) return `${current}.1`;
  const digits = match[1];
  const next = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
  return current.slice(0, match.index) + next;
}

/**
 * The firmware version after a successful update:
 *
 * 1. the first version-like token (`/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/`)
 *    in the file name of `location` ({@link firmwareFileStem}):
 *    `https://x/fw/cp-firmware-2.3.1.bin` → `2.3.1`,
 *    `v1.4.0-rc1.tar.gz` → `1.4.0-rc1`;
 * 2. else {@link incrementFirmwareVersion} of `current`;
 *
 * truncated to {@link FIRMWARE_VERSION_MAX_LENGTH} characters. A token equal
 * to `current` is kept: the CSMS rolled the same version out again.
 */
export function deriveFirmwareVersion(
  location: string | undefined,
  current: string | undefined,
): string {
  const token = VERSION_TOKEN.exec(firmwareFileStem(location ?? ""));
  const version = token ? token[0] : incrementFirmwareVersion(current ?? "");
  return version.slice(0, FIRMWARE_VERSION_MAX_LENGTH);
}
