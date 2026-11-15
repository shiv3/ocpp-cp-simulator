import { requireNumberFlag, requireFlagValue } from "../flagValues";
import { printUsage } from "../usage";
import type { ParseState } from "./parseState";

/**
 * Reconnect and `--ws-*` transport flags, boot retries, TxUpdated meter values,
 * the web console and `--help`.
 * Returns false when `arg` is none of them (#877).
 */
export function parseConnectionFlag(
  s: ParseState,
  arg: string,
  next: string,
  cur: { i: number },
): boolean {
  switch (arg) {
    case "--reconnect-max-attempts":
      s.reconnect.maxAttempts = requireNumberFlag(arg, next, {
        integer: true,
        min: -1,
      });
      cur.i++;
      break;
    case "--reconnect-mode": {
      const mode = requireFlagValue(arg, next);
      if (mode !== "exponential" && mode !== "fixed") {
        process.stderr.write(
          'Error: --reconnect-mode must be "exponential" or "fixed"\n',
        );
        process.exit(1);
      }
      s.reconnect.mode = mode;
      cur.i++;
      break;
    }
    case "--reconnect-base-delay-ms":
      s.reconnect.baseDelayMs = requireNumberFlag(arg, next, { min: 0 });
      cur.i++;
      break;
    case "--reconnect-max-delay-ms":
      s.reconnect.maxDelayMs = requireNumberFlag(arg, next, { min: 0 });
      cur.i++;
      break;
    case "--reconnect-jitter-ms":
      s.reconnect.jitterMs = requireNumberFlag(arg, next, { min: 0 });
      cur.i++;
      break;
    case "--ws-handshake-timeout-ms":
      s.wsFlags.handshakeTimeoutMs = requireNumberFlag(arg, next, {
        min: 1,
      });
      cur.i++;
      break;
    case "--ws-no-compression":
      s.wsFlags.perMessageDeflate = false;
      break;
    case "--ws-max-payload":
      s.wsFlags.maxPayloadBytes = requireNumberFlag(arg, next, {
        integer: true,
        min: 1,
      });
      cur.i++;
      break;
    case "--ws-proxy":
      s.wsFlags.proxy = requireFlagValue(arg, next);
      cur.i++;
      break;
    case "--ws-local-address":
      s.wsFlags.localAddress = requireFlagValue(arg, next);
      cur.i++;
      break;
    case "--boot-retry-limit":
      s.reconnect.bootRetryLimit = requireNumberFlag(arg, next, {
        integer: true,
        min: -1,
      });
      cur.i++;
      break;
    case "--tx-updated-meter-values":
      s.txUpdatedMeterValues = true;
      break;
    case "--no-tx-updated-meter-values":
      s.txUpdatedMeterValues = false;
      break;
    case "--web-console":
      s.webConsoleEnabled = true;
      // Optional port: only consume `next` when it looks like a number.
      // If `next` is missing or another flag, the UI shares --http-port.
      if (next && !next.startsWith("--") && /^\d+$/.test(next)) {
        s.webConsoleExplicitPort = parseInt(next, 10);
        cur.i++;
      }
      break;
    case "--web-console-dist":
      s.webConsoleDist = requireFlagValue("--web-console-dist", next);
      cur.i++;
      break;
    case "--help":
    case "-h":
      printUsage();
      process.exit(0);
      break;
    default:
      return false;
  }
  return true;
}
