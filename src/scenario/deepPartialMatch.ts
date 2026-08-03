/**
 * Deep partial match shared by assertion `payload_match` checks and the
 * #240 payload-conditioned csmsCallTrigger wait: every key in `subset` must
 * be present in `actual` with a deep-equal value. Objects are matched as a
 * subset (extra keys in `actual` are ignored); arrays are compared
 * element-by-element and must be the same length — an author pinning an
 * array generally means the whole array, not just a prefix.
 *
 * The k6 export runtime keeps its own copy in
 * src/cli/exportK6/runtime/assertions.ts (the runtime purity gate forbids
 * repo imports); src/scenario/__tests__/deepPartialMatch.test.ts runs a
 * shared vector table against both to keep them from drifting.
 */
export function deepPartialMatch(subset: unknown, actual: unknown): boolean {
  if (subset === actual) return true;
  if (
    typeof subset !== "object" ||
    subset === null ||
    typeof actual !== "object" ||
    actual === null
  ) {
    return false;
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual) || subset.length !== actual.length) {
      return false;
    }
    return subset.every((item, i) => deepPartialMatch(item, actual[i]));
  }
  if (Array.isArray(actual)) return false;
  const subsetObj = subset as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  return Object.keys(subsetObj).every((key) =>
    deepPartialMatch(subsetObj[key], actualObj[key]),
  );
}
