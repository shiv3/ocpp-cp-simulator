/**
 * Argument parser for the `analyze` subcommand.
 *
 * Kept out of main.ts's `parseArgs()` switch and its own module (rather than
 * inline in main.ts's early dispatch) so the flag/format edge cases are unit
 * testable without spawning a `bun` subprocess for each one. It returns a
 * result object instead of calling `process.exit()` itself for the same
 * reason: a pure function is trivial to assert against in vitest.
 */

export interface AnalyzeCliArgs {
  /** Trace file to read. Undefined when `fromDaemon` is set. */
  file?: string;
  output?: string;
  format?: "html" | "markdown";
  /** Build the trace from a running daemon's stored logs instead of a file.
   *  Only ever `true` or absent, so `toEqual` assertions that predate this
   *  flag keep passing. */
  fromDaemon?: true;
  /** Charge point whose logs to pull. Required by `--from-daemon` because
   *  the daemon's `logs.get` RPC is scoped to one charge point. */
  cpId?: string;
  httpUrl?: string;
  httpBasicAuth?: { username: string; password: string };
}

export type AnalyzeCliParseResult =
  { ok: true; args: AnalyzeCliArgs } | { ok: false; message: string };

export const ANALYZE_USAGE =
  "Usage: ocpp-cp-sim analyze <trace.jsonl> [--output <file>] [--format html|markdown]\n" +
  "       ocpp-cp-sim analyze --from-daemon --cp-id <id> [--http-url <url>]\n" +
  "                           [--http-basic-auth-user <u> --http-basic-auth-pass <p>]\n" +
  "                           [--output <file>] [--format html|markdown]";

/** Flags that only mean something when the trace comes from a daemon. */
const DAEMON_ONLY_FLAGS = [
  "--cp-id",
  "--http-url",
  "--http-basic-auth-user",
  "--http-basic-auth-pass",
];

export function parseAnalyzeArgs(argv: string[]): AnalyzeCliParseResult {
  let file: string | undefined;
  let output: string | undefined;
  let format: "html" | "markdown" | undefined;
  let fromDaemon = false;
  let cpId: string | undefined;
  let httpUrl: string | undefined;
  let basicAuthUser: string | undefined;
  let basicAuthPass: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, message: `Error: ${arg} requires a value` };
      }
      output = next;
      i++;
    } else if (arg === "--format") {
      const next = argv[i + 1];
      if (next !== "html" && next !== "markdown") {
        return {
          ok: false,
          message: "Error: --format must be 'html' or 'markdown'",
        };
      }
      format = next;
      i++;
    } else if (arg === "--from-daemon") {
      fromDaemon = true;
    } else if (DAEMON_ONLY_FLAGS.includes(arg)) {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, message: `Error: ${arg} requires a value` };
      }
      if (arg === "--cp-id") cpId = next;
      else if (arg === "--http-url") httpUrl = next;
      else if (arg === "--http-basic-auth-user") basicAuthUser = next;
      else basicAuthPass = next;
      i++;
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `Unknown option: ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else {
      // A second positional argument: analyze only takes one trace file.
      return { ok: false, message: `Unknown option: ${arg}` };
    }
  }

  const daemonFlagsUsed =
    cpId !== undefined ||
    httpUrl !== undefined ||
    basicAuthUser !== undefined ||
    basicAuthPass !== undefined;

  if (!fromDaemon && daemonFlagsUsed) {
    return {
      ok: false,
      message:
        "Error: --cp-id / --http-url / --http-basic-auth-* are only valid " +
        `with --from-daemon\n${ANALYZE_USAGE}`,
    };
  }

  if (fromDaemon) {
    // A file and a daemon are two different trace sources; silently
    // preferring one would hide which of the two the report describes.
    if (file !== undefined) {
      return {
        ok: false,
        message:
          "Error: --from-daemon cannot be combined with a trace file " +
          `(got "${file}")\n${ANALYZE_USAGE}`,
      };
    }
    if (!cpId) {
      return {
        ok: false,
        message: `Error: --from-daemon requires --cp-id <id>\n${ANALYZE_USAGE}`,
      };
    }
    // Half-specified Basic Auth is a misconfiguration, not a request for
    // anonymous access -- the daemon would reject it with an opaque 401.
    if ((basicAuthUser === undefined) !== (basicAuthPass === undefined)) {
      return {
        ok: false,
        message:
          "Error: --http-basic-auth-user and --http-basic-auth-pass must be " +
          `given together\n${ANALYZE_USAGE}`,
      };
    }
    return {
      ok: true,
      args: {
        file: undefined,
        output,
        format,
        fromDaemon: true,
        cpId,
        httpUrl,
        httpBasicAuth:
          basicAuthUser !== undefined && basicAuthPass !== undefined
            ? { username: basicAuthUser, password: basicAuthPass }
            : undefined,
      },
    };
  }

  if (!file) {
    return {
      ok: false,
      message: `Error: analyze requires a trace file path\n${ANALYZE_USAGE}`,
    };
  }

  return { ok: true, args: { file, output, format } };
}
