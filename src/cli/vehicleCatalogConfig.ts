import { PUBLIC_OED_BASE_URL } from "../cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import { isHttpUrl } from "./soapCallbackUrl";

/**
 * Where the daemon's vehicle catalog (#458) is and which key it uses.
 *
 * The key is read from the environment or a file, never from a flag that
 * carries its value: a command line is visible to every user of the host
 * (`ps`), an environment or a mounted secret file is not. Nothing here puts
 * the key in a message.
 *
 * Without a base URL the public instance is used: nothing is called until a
 * user imports a vehicle, and `none` turns import off.
 */
export interface VehicleCatalogConfig {
  baseUrl: string;
  apiKey: string | undefined;
}

export type VehicleCatalogConfigResult =
  | { ok: true; config: VehicleCatalogConfig | null; warnings: string[] }
  | { ok: false; message: string };

export function resolveVehicleCatalogConfig(input: {
  /** `--oed-base-url`, already checked to be http(s) or `none` by the parser. */
  flagBaseUrl: string | null;
  /** `--oed-api-key-file`. */
  flagApiKeyFile: string | null;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
}): VehicleCatalogConfigResult {
  const envBaseUrl = blankToNull(input.env.OED_BASE_URL);
  if (
    !input.flagBaseUrl &&
    envBaseUrl &&
    !isOff(envBaseUrl) &&
    !isHttpUrl(envBaseUrl)
  ) {
    return {
      ok: false,
      message: "OED_BASE_URL must be an absolute http(s) URL or none",
    };
  }
  const chosen = input.flagBaseUrl ?? envBaseUrl ?? PUBLIC_OED_BASE_URL;
  const baseUrl = isOff(chosen) ? null : chosen;

  let apiKey: string | undefined;
  const keyFile = input.flagApiKeyFile
    ? { path: input.flagApiKeyFile, source: "--oed-api-key-file" }
    : blankToNull(input.env.OED_API_KEY_FILE)
      ? { path: input.env.OED_API_KEY_FILE!.trim(), source: "OED_API_KEY_FILE" }
      : null;
  if (keyFile) {
    let content: string;
    try {
      content = input.readFile(keyFile.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `${keyFile.source} ${keyFile.path} cannot be read: ${reason}`,
      };
    }
    apiKey = blankToNull(content) ?? undefined;
    if (!apiKey) {
      return {
        ok: false,
        message: `${keyFile.source} ${keyFile.path} is empty`,
      };
    }
  } else {
    apiKey = blankToNull(input.env.OED_API_KEY) ?? undefined;
  }

  if (!baseUrl) {
    return {
      ok: true,
      config: null,
      warnings: apiKey
        ? [
            "An Open EV Directory API key is set but vehicle import is turned off (--oed-base-url none / OED_BASE_URL=none)",
          ]
        : [],
    };
  }
  return { ok: true, config: { baseUrl, apiKey }, warnings: [] };
}

/** `none` (any case) turns vehicle import off. */
export function isOff(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase() === "none";
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
