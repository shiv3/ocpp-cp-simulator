import * as fs from "fs";
import type { CLIOptions } from "../types";
import { SUPPORTED_OCPP_VERSIONS } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";

export const OCPP_VERSION_VALUES = SUPPORTED_OCPP_VERSIONS.join(", ");

export function parseSecurityProfile(
  value: string | undefined,
): CLIOptions["securityProfile"] {
  if (value === "0" || value === "1" || value === "2" || value === "3") {
    return Number(value) as CLIOptions["securityProfile"];
  }
  process.stderr.write("Error: --security-profile must be one of 0, 1, 2, 3\n");
  process.exit(1);
}

/** A number flag (#609): `-1` is allowed for the counts that mean unlimited. */
export function requireNumberFlag(
  flag: string,
  value: string | undefined,
  opts: { integer?: boolean; min: number },
): number {
  const text = requireFlagValue(flag, value);
  const n = Number(text);
  if (
    !/^-?\d+(\.\d+)?$/.test(text) ||
    !Number.isFinite(n) ||
    n < opts.min ||
    (opts.integer && !Number.isInteger(n))
  ) {
    process.stderr.write(
      `Error: ${flag} must be ${opts.integer ? "an integer" : "a number"} >= ${opts.min}, got "${text}"\n`,
    );
    process.exit(1);
  }
  return n;
}

export function requireFlagValue(
  flag: string,
  value: string | undefined,
): string {
  if (!value || value.startsWith("--")) {
    process.stderr.write(`Error: ${flag} requires a value\n`);
    process.exit(1);
  }
  return value;
}

export function readPemFile(flag: string, filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `Error: failed to read ${flag} file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}
