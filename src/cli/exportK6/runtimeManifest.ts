// src/cli/exportK6/runtimeManifest.ts
// The exact set of runtime files emitted into an export bundle. A unit test
// asserts this matches the runtime/ directory listing so a new file cannot be
// silently dropped from exports.
export const RUNTIME_FILES: readonly string[] = [
  "assertions.ts",
  "autoResponder.ts",
  "frames.ts",
  "index.ts",
  "interpreter.ts",
  "metrics.ts",
  "ocppClient.ts",
  "profiles.ts",
  "types.ts",
  "wire/v16.ts",
];

/** Runtime files allowed to import k6/* modules; all others must stay pure so
 * they remain unit-testable under vitest. */
export const K6_ONLY_FILES: readonly string[] = [
  "index.ts",
  "metrics.ts",
  "ocppClient.ts",
];
