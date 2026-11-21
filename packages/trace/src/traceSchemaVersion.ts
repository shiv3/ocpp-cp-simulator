/**
 * Trace format version stamped on every produced record. A literal copy of
 * `SCHEMA_VERSION` from `@open-ocpp-trace/core` so that building records does
 * not load the SDK at runtime: the SDK is an optional dependency published on
 * GitHub Packages only. A test pins this to the SDK's value whenever the SDK
 * is installed.
 */
export const TRACE_SCHEMA_VERSION = "1.1";
