/** Stdout side of JSON Lines mode. */

// Only `console` writes stdout here: mixed with process.stdout, Bun cuts large lines (#1076).
let stdoutLine: ((line: string) => void) | null = null;

export function writeLine(obj: unknown): void {
  (stdoutLine ?? console.log)(JSON.stringify(obj));
}

/**
 * Make stdout pure JSON Lines (#1088, `--log-to-stderr`): keep the original `console.log` for the
 * protocol lines written by {@link writeLine} and send everything else the
 * simulator prints through `console.log` / `console.info` / `console.debug`
 * (the Logger's `[INFO] ...` lines) to stderr. Call before
 * {@link installLogSink} so `--log-level` / `--log-file` see the redirected
 * methods and never filter the protocol lines.
 */
export function routeLogsToStderr(): void {
  if (stdoutLine) return;
  stdoutLine = console.log.bind(console) as (line: string) => void;
  const toStderr = console.error.bind(console);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
