export type UnsupportedFeatureCode = "browser_tls_unsupported";

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
