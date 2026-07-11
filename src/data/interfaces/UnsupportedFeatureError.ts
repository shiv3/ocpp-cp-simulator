export type UnsupportedFeatureCode =
  | "browser_tls_unsupported"
  | "browser_soap_unsupported"
  | "browser_scenario_file_unsupported"
  | "browser_scenario_executor_unavailable";

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

export const BROWSER_SOAP_UNSUPPORTED_MESSAGE =
  "OCPP SOAP versions (1.2/1.5/1.6S) are CLI/server-only; browser local mode cannot host the SOAP callback service.";

export const BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE =
  "Running a scenario from a filesystem path is CLI/server-only; load a scenario definition in the browser first or use the daemon runtime.";

export const BROWSER_SCENARIO_EXECUTOR_UNAVAILABLE_MESSAGE =
  "Scenario execution is only available after the browser connector UI has mounted its scenario executor.";
