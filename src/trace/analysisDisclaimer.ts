/**
 * Issue #188 PoC item 8: the detector only recognizes a fixed catalog of
 * known failure shapes -- it is not a conformance checker. Required on every
 * analysis surface (the CLI `analyze` command, the web console's Session
 * Analysis tab) so a clean run can never be read as "this station is OCPP
 * compliant". Browser-safe (no node imports) so both surfaces can share it;
 * `src/cli/analyze/runAnalyze.ts` re-exports this unchanged.
 */
export const ANALYZE_DISCLAIMER =
  'Failure-pattern detection is not OCPP compliance certification: "no known failure detected" does not mean "OCPP compliant".';
