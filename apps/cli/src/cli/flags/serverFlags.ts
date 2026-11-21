import { DEFAULT_HTTP_PORT } from "../../server/startServer";
import { parseTrustedProxy } from "../../server/accessGuard";
import { parseLogLevel, parseSize } from "../../logSink";
import type { ParseState } from "./parseState";

/**
 * Startup scenario, the daemon's HTTP / Unix socket listener and client
 * target, behaviors, access control, logging, shutdown, state and tracing.
 * Returns false when `arg` is none of them (#877).
 */
export function parseServerFlag(
  s: ParseState,
  arg: string,
  next: string,
  cur: { i: number },
): boolean {
  switch (arg) {
    case "--scenario":
      s.scenario = next ?? "";
      cur.i++;
      break;
    case "--scenario-template":
      s.scenarioTemplate = next ?? "";
      cur.i++;
      break;
    case "--scenario-template-file":
      s.scenarioTemplateFile = next ?? "";
      cur.i++;
      break;
    case "--scenario-connector":
      s.scenarioConnector = next ?? "1";
      cur.i++;
      break;
    case "--http-port":
      s.httpPort = parseInt(next ?? "", 10);
      cur.i++;
      break;
    case "--http-host":
      s.httpHost = next ?? "";
      cur.i++;
      break;
    case "--unix-socket":
      if (!s.unixSocketWarningPrinted) {
        process.stderr.write(
          "Warning: --unix-socket is deprecated and ignored; the daemon " +
            `uses TCP loopback by default (http://127.0.0.1:${DEFAULT_HTTP_PORT}).\n`,
        );
        s.unixSocketWarningPrinted = true;
      }
      s.unixSocket = null;
      if (next && !next.startsWith("--")) cur.i++;
      break;
    case "--http-url":
      s.httpUrl = next ?? "";
      cur.i++;
      break;
    case "--all":
      s.allEvents = true;
      break;
    case "--unsafe-remote":
      s.unsafeRemote = true;
      break;
    case "--behavior":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --behavior requires a file path\n");
        process.exit(1);
      }
      s.behaviorFiles.push(next);
      cur.i++;
      break;
    case "--allow-behavior-code":
      s.allowBehaviorCode = true;
      break;
    case "--use-behavior":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --use-behavior requires a behavior id\n");
        process.exit(1);
      }
      s.useBehaviors.push(next);
      cur.i++;
      break;
    case "--behavior-params":
      if (!next || next.startsWith("--")) {
        process.stderr.write(
          "Error: --behavior-params requires <id>=<json file or inline json>\n",
        );
        process.exit(1);
      }
      s.behaviorParamSpecs.push(next);
      cur.i++;
      break;
    case "--watch-behaviors":
      s.watchBehaviors = true;
      break;
    case "--allow-behavior-reload":
      s.allowBehaviorReload = true;
      break;
    case "--cors-origin":
      if (!next || next.startsWith("--")) {
        process.stderr.write(
          "Error: --cors-origin requires a value (refusing to fall back to open CORS)\n",
        );
        process.exit(1);
      }
      s.corsOrigins.push(next);
      cur.i++;
      break;
    case "--allowed-host":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --allowed-host requires a host name\n");
        process.exit(1);
      }
      s.allowedHosts.push(next);
      cur.i++;
      break;
    case "--trusted-proxy":
      if (!next || next.startsWith("--") || !parseTrustedProxy(next)) {
        process.stderr.write(
          "Error: --trusted-proxy requires an IP address or CIDR (for example 10.0.0.0/8)\n",
        );
        process.exit(1);
      }
      s.trustedProxies.push(next);
      cur.i++;
      break;
    case "--require-tls":
      s.requireTls = true;
      break;
    case "--rate-limit-per-ip":
    case "--rate-limit-max-ips":
    case "--log-keep":
    case "--shutdown-wait-ms":
    case "--cp-bulk-wait-ms": {
      const value = Number(next);
      const min = arg === "--rate-limit-max-ips" ? 1 : 0;
      if (!next || !/^\d+$/.test(next) || value < min) {
        process.stderr.write(
          `Error: ${arg} requires a whole number >= ${min}\n`,
        );
        process.exit(1);
      }
      if (arg === "--rate-limit-per-ip") s.rateLimitPerIp = value;
      else if (arg === "--rate-limit-max-ips") s.rateLimitMaxIps = value;
      else if (arg === "--log-keep") s.logKeep = value;
      else if (arg === "--shutdown-wait-ms") s.shutdownWaitMs = value;
      else s.cpBulkWaitMs = value;
      cur.i++;
      break;
    }
    case "--log-level": {
      const level = parseLogLevel(next);
      if (!level) {
        process.stderr.write(
          "Error: --log-level must be debug, info, warn or error\n",
        );
        process.exit(1);
      }
      s.logLevel = level;
      cur.i++;
      break;
    }
    case "--log-file":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --log-file requires a file path\n");
        process.exit(1);
      }
      s.logFile = next;
      cur.i++;
      break;
    case "--log-max-size": {
      const bytes = parseSize(next);
      if (bytes === null) {
        process.stderr.write(
          "Error: --log-max-size requires a size such as 10m, 512k or 1048576\n",
        );
        process.exit(1);
      }
      s.logMaxBytes = bytes;
      cur.i++;
      break;
    }
    case "--log-to-stderr":
      s.logToStderr = true;
      break;
    case "--log-rotate-daily":
      s.logRotateDaily = true;
      break;
    case "--shutdown-stop-transactions":
      s.shutdownStopTransactions = true;
      break;
    case "--no-connect-restored":
      s.connectRestored = false;
      break;
    case "--trust-forwarded-headers":
      s.trustForwardedHeaders = true;
      break;
    case "--state-db":
      if (!next || next.startsWith("--")) {
        process.stderr.write(
          "Error: --state-db requires a path (or ':memory:')\n",
        );
        process.exit(1);
      }
      s.stateDb = next;
      cur.i++;
      break;
    case "--trace-output":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --trace-output requires a file path\n");
        process.exit(1);
      }
      s.traceOutput = next;
      cur.i++;
      break;
    case "--log-format":
      if (next !== "plain" && next !== "json") {
        process.stderr.write("Error: --log-format must be 'plain' or 'json'\n");
        process.exit(1);
      }
      s.logFormat = next;
      cur.i++;
      break;
    case "--health-path":
      if (!next || next.startsWith("--") || !next.startsWith("/")) {
        process.stderr.write(
          "Error: --health-path requires an absolute path starting with '/'\n",
        );
        process.exit(1);
      }
      s.healthPath = next;
      cur.i++;
      break;
    default:
      return false;
  }
  return true;
}
