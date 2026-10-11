import { isHttpUrl } from "./soapCallbackUrl";

/**
 * Where the daemon's vehicle catalog (#458) is and which key it uses.
 *
 * The key is read from the environment or a file, never from a flag that
 * carries its value: a command line is visible to every user of the host
 * (`ps`), an environment or a mounted secret file is not. Nothing here puts
 * the key in a message.
 */
export interface VehicleCatalogConfig {
  baseUrl: string;
  apiKey: string | undefined;
}

export type VehicleCatalogConfigResult =
  | { ok: true; config: VehicleCatalogConfig | null; warnings: string[] }
  | { ok: false; message: string };

export function resolveVehicleCatalogConfig(input: {
  /** `--oed-base-url`, already checked to be http(s) by the parser. */
  flagBaseUrl: string | null;
  /** `--oed-api-key-file`. */
  flagApiKeyFile: string | null;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
}): VehicleCatalogConfigResult {
  const envBaseUrl = blankToNull(input.env.OED_BASE_URL);
  if (!input.flagBaseUrl && envBaseUrl && !isHttpUrl(envBaseUrl)) {
    return {
      ok: false,
      message: "OED_BASE_URL must be an absolute http(s) URL",
    };
  }
  const baseUrl = input.flagBaseUrl ?? envBaseUrl;

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
            "An Open EV Directory API key is set but no base URL (--oed-base-url or OED_BASE_URL); vehicle import is disabled",
          ]
        : [],
    };
  }
  return { ok: true, config: { baseUrl, apiKey }, warnings: [] };
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
