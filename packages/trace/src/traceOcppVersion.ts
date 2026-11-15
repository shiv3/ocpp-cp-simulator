/** Map an OcppVersion constant to the plain protocol number the trace format
 *  wants (docs/concepts/trace-format.md), e.g. "OCPP-1.6J" -> "1.6".
 *  Undefined falls back to "1.6", matching `parseOcppVersion`'s fallback. */
export function toTraceOcppVersion(ocppVersion: string | undefined): string {
  switch (ocppVersion) {
    case "OCPP-1.2":
      return "1.2";
    case "OCPP-1.5":
      return "1.5";
    case "OCPP-2.0.1":
      return "2.0.1";
    case "OCPP-2.1":
      return "2.1";
    case "OCPP-1.6S":
    case "OCPP-1.6J":
    default:
      return "1.6";
  }
}
