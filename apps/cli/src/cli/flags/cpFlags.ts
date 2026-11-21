import {
  labelKeySchema,
  labelValueSchema,
} from "@ocpp-cp-simulator/contracts/labels";
import { isOcppVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { OCPP_VERSION_VALUES, requireFlagValue } from "../flagValues";
import { MAX_TIME_SCALE } from "../../timeScale";
import type { ParseState } from "./parseState";

/**
 * Charge point identity, fleet and pacing, labels, the mode selectors,
 * the WebSocket / HTTP Basic Auth credentials, vendor / model and OCPP version.
 * Returns false when `arg` is none of them (#877).
 */
export function parseCpFlag(
  s: ParseState,
  arg: string,
  next: string,
  cur: { i: number },
): boolean {
  switch (arg) {
    case "--ws-url":
      s.wsUrl = next ?? "";
      cur.i++;
      break;
    case "--cp-id":
      s.cpId = next ?? "";
      cur.i++;
      break;
    case "--connectors":
      s.connectors = parseInt(next ?? "1", 10);
      cur.i++;
      break;
    case "--cp-count":
      s.cpCount = parseInt(next ?? "1", 10);
      cur.i++;
      break;
    case "--fleet-template":
      if (!next || next.startsWith("--")) {
        process.stderr.write("Error: --fleet-template needs a file path\n");
        process.exit(1);
      }
      s.fleetTemplateFiles.push(next);
      cur.i++;
      break;
    case "--bootstrap-concurrency":
      s.bootstrapConcurrency = next ?? "";
      cur.i++;
      break;
    case "--start-delay":
      s.startDelay = next ?? "";
      cur.i++;
      break;
    case "--start-jitter":
      s.startJitter = next ?? "";
      cur.i++;
      break;
    case "--start-seed":
      s.startSeed = next ?? "";
      cur.i++;
      break;
    case "--cp-id-pattern":
      s.cpIdPattern = next ?? null;
      cur.i++;
      break;
    case "--label": {
      if (!next || next.startsWith("--")) {
        process.stderr.write(
          "Error: --label requires KEY=VALUE (use multiple --label flags for several labels)\n",
        );
        process.exit(1);
      }
      // `=` cannot appear in a key, so the first one is the separator and
      // the value keeps any later `=` or `,` verbatim.
      const idx = next.indexOf("=");
      if (idx <= 0) {
        process.stderr.write(
          `Error: --label value must be KEY=VALUE, got '${next}'\n`,
        );
        process.exit(1);
      }
      const key = next.slice(0, idx);
      const value = next.slice(idx + 1);
      // Checked one by one rather than left to `labelsSchema` on the whole
      // map: the record schema drops a `__proto__` key without an issue, so
      // `--label __proto__=x` would vanish instead of being refused.
      if (!labelKeySchema.safeParse(key).success) {
        process.stderr.write(
          `Error: --label key '${key}' is invalid (${labelKeySchema.description})\n`,
        );
        process.exit(1);
      }
      if (!labelValueSchema.safeParse(value).success) {
        process.stderr.write(
          `Error: --label value for '${key}' is invalid (${labelValueSchema.description})\n`,
        );
        process.exit(1);
      }
      if (s.labelEntries.some(([k]) => k === key)) {
        // Last-wins would silently drop one of two values the operator
        // typed; refuse instead, like every other ambiguous startup flag.
        process.stderr.write(`Error: --label key '${key}' given twice\n`);
        process.exit(1);
      }
      s.labelEntries.push([key, value]);
      cur.i++;
      break;
    }
    case "--time-scale": {
      const value = Number(requireFlagValue("--time-scale", next));
      if (!Number.isFinite(value) || value <= 0 || value > MAX_TIME_SCALE) {
        process.stderr.write(
          `Error: --time-scale must be a number above 0 and at most ${MAX_TIME_SCALE}\n`,
        );
        process.exit(1);
      }
      s.timeScale = value;
      cur.i++;
      break;
    }
    case "--metrics":
      s.metrics = true;
      break;
    case "--metrics-no-auth":
      s.metrics = true;
      s.metricsNoAuth = true;
      break;
    case "--watch":
      s.watch = true;
      break;
    case "--json":
      s.jsonMode = true;
      break;
    case "--daemon":
      s.daemon = true;
      break;
    case "--send":
      s.send = next ?? "";
      cur.i++;
      break;
    case "--events":
      s.events = true;
      break;
    case "--stop":
      s.stop = true;
      break;
    case "--basic-auth-user":
      s.basicAuthUser = next ?? "";
      cur.i++;
      break;
    case "--basic-auth-pass":
      s.basicAuthPass = next ?? "";
      cur.i++;
      break;
    case "--web-console-basic-auth-user":
      s.webConsoleBasicAuthUser = next ?? "";
      cur.i++;
      break;
    case "--web-console-basic-auth-pass":
      s.webConsoleBasicAuthPass = next ?? "";
      cur.i++;
      break;
    case "--http-basic-auth-user":
      s.httpBasicAuthUser = next ?? "";
      cur.i++;
      break;
    case "--http-basic-auth-pass":
      s.httpBasicAuthPass = next ?? "";
      cur.i++;
      break;
    case "--vendor":
      s.vendor = next ?? "";
      cur.i++;
      break;
    case "--model":
      s.model = next ?? "";
      cur.i++;
      break;
    case "--ocpp-version":
      if (!next || next.startsWith("--") || !isOcppVersion(next)) {
        process.stderr.write(
          `Error: --ocpp-version must be one of ${OCPP_VERSION_VALUES}\n`,
        );
        process.exit(1);
      }
      s.ocppVersion = next;
      cur.i++;
      break;
    default:
      return false;
  }
  return true;
}
