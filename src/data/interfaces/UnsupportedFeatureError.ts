export type UnsupportedFeatureCode =
  | "browser_tls_unsupported"
  | "browser_scenario_file_unsupported"
  | "browser_auto_traffic_unsupported";

export class UnsupportedFeatureError extends Error {
  readonly code: UnsupportedFeatureCode;

  constructor(code: UnsupportedFeatureCode, message: string) {
    super(message);
    this.name = "UnsupportedFeatureError";
    this.code = code;
  }
}

export const BROWSER_TLS_UNSUPPORTED_MESSAGE =
  "OCPP security profiles 2/3 and TLS certificate files are CLI/server-only; use the CLI or daemon runtime for TLS/mTLS.";

export const BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE =
  "Running a scenario from a filesystem path is CLI/server-only; load a scenario definition in the browser first or use the daemon runtime.";

export const BROWSER_AUTO_TRAFFIC_UNSUPPORTED_MESSAGE =
  "Seeded background traffic is CLI/server-only; configure it on the daemon runtime.";
