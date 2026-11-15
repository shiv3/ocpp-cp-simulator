import type { ChargePointInitOptions } from "../types";
import {
  matchesLabelSelector,
  type Labels,
} from "@ocpp-cp-simulator/contracts/labels";
import { expandIdPattern } from "@ocpp-cp-simulator/contracts/index";
import {
  localHostForTunnel,
  startSoapTunnel,
  type SoapTunnel,
} from "../soapTunnel";
import { soapCallbackRouteCpId } from "./socketServer";
import type { FileReloadManager } from "./FileReloadManager";
import { getGlobalLogFormat } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { ServerOptions } from "./serverOptions";

/**
 * Suffix for the "reusing" log line when `--label` asked for labels a
 * restored charge point does not carry (#472). The restored labels win, like
 * every other bootstrap option; saying so keeps the flag from looking broken
 * to an operator who added it to an existing deployment.
 */
export function labelsNotAppliedNote(
  requested: Labels | undefined,
  restored: Labels | undefined,
): string {
  if (!requested) return "";
  const same =
    restored !== undefined &&
    Object.keys(requested).length === Object.keys(restored).length &&
    matchesLabelSelector(restored, requested);
  if (same) return "";
  return ` (--label not applied; it keeps its stored labels ${JSON.stringify(restored ?? {})})`;
}

/**
 * The charge points `--cp-id` (plus `--cp-count` / `--cp-id-pattern`) asks for.
 *
 * One without a count, N with one — sequential, so the log and the registry
 * events read in id order. Everything but `cpId` is shared, exactly as
 * `cp.create_many` shares it — `--label` labels included (#472).
 */
export function expandBootstrap(
  opts: ServerOptions,
): readonly ChargePointInitOptions[] {
  if (!opts.bootstrap) return [];
  const count = opts.bootstrapCount ?? 1;
  if (count <= 1) return [opts.bootstrap];
  const pattern = opts.bootstrapIdPattern ?? `${opts.bootstrap.cpId}{n:03}`;
  const fleet: ChargePointInitOptions[] = [];
  for (let i = 1; i <= count; i++) {
    const cpId = expandIdPattern(pattern, i);
    const explicit = opts.soapCallbackUrlExplicit?.trim();
    fleet.push({
      ...opts.bootstrap,
      cpId,
      // Without an explicit URL the registry derives one per station from
      // the daemon's SOAP public base at instantiation (#183).
      ...(explicit
        ? { soapCallbackUrl: expandExplicitSoapCallbackUrl(explicit, cpId, i) }
        : {}),
    });
  }
  return fleet;
}

/**
 * Open the SOAP tunnel described by `--soap-tunnel` towards the SOAP-only
 * listener bound on `localPort`, or nothing. Exported for tests; `start` is
 * the tunnel provider, injectable so the wiring can be checked without an
 * ngrok binary.
 */
export async function openSoapTunnel(
  opts: Pick<
    ServerOptions,
    "soapTunnel" | "soapCallbackUrlExplicit" | "soapPublicBaseUrl" | "httpHost"
  >,
  localPort: number,
  onExit: (code: number | null) => void,
  start: typeof startSoapTunnel = startSoapTunnel,
): Promise<SoapTunnel | null> {
  if (!opts.soapTunnel) return null;
  if (opts.soapCallbackUrlExplicit?.trim() || opts.soapPublicBaseUrl?.trim()) {
    throw new Error(
      "--soap-tunnel cannot be combined with --soap-callback-url or --soap-public-base-url",
    );
  }
  return start({
    localHost: localHostForTunnel(opts.httpHost),
    localPort,
    authToken: opts.soapTunnel.authToken,
    domain: opts.soapTunnel.domain,
    apiUrl: opts.soapTunnel.apiUrl,
    onExit,
  });
}

/**
 * Expand an explicit `--soap-callback-url` for one charge point of a fleet.
 *
 * The daemon routes inbound CS→CP calls on `<soapPath>/<cpId>/ChargePointService`
 * and advertises this URL verbatim, so a fleet sharing one address would send
 * every station's callbacks to the first station's route. The explicit URL
 * therefore carries the same `{n}` placeholder as the id pattern (the CLI
 * refuses one that does not), and its expansion is checked against the route.
 */
export function expandExplicitSoapCallbackUrl(
  explicit: string,
  cpId: string,
  index: number,
): string {
  const expanded = expandIdPattern(explicit, index);
  // Same rule the RPC enforces, checked the same way — through the router's
  // own pattern and percent-decoding, so the two cannot disagree about an id
  // that needs encoding or a path with an extra segment.
  if (soapCallbackRouteCpId(expanded) !== cpId) {
    throw new Error(
      `--soap-callback-url expands to "${expanded}", whose charge point route segment is not "${cpId}". ` +
        `The daemon routes inbound SOAP calls by that segment, so the CSMS would get 404s.`,
    );
  }
  return expanded;
}

/**
 * Setup-time chatter from the daemon ("[server] Listening on …",
 * "[server] Connecting to CSMS…"). Plain mode keeps the legacy
 * "[server] <msg>" prefix; JSON mode wraps each call in a one-line JSON
 * object so the whole stderr stream is structured.
 */
export function serverLog(message: string): void {
  if (getGlobalLogFormat() === "json") {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        type: "Server",
        message,
      }) + "\n",
    );
    return;
  }
  process.stderr.write(`[server] ${message}\n`);
}

/**
 * Second pass of the watch restore, then say what is being watched (#314).
 *
 * Three constraints have to hold at once, and no single position in the
 * sequence satisfies all three — which is why the restore is split rather than
 * moved again:
 *
 * 1. **A restored charge point must not run a stale graph.** Its persisted
 *    connect-triggered scenarios start as soon as its boot gate opens, so the
 *    watch has to be back and the file reconciled *before* it dials. The first
 *    pass runs immediately after `restoreFromDatabase({ connect: false })` and
 *    before `connectRestored`.
 * 2. **A startup flag owns its keys before its rows are read.** A stored row
 *    can name the id `--scenario` will claim, and reconciling it first would
 *    put the abandoned graph on the connector and possibly start it. The first
 *    pass therefore skips the bootstrap charge points; this second pass, after
 *    `runStartupScenario`, picks up whatever the flags did not claim — by then
 *    a takeover has deleted the rows they did.
 * 3. **A restored row must not overwrite a live registration.** The listener is
 *    bound before the bootstrap, so an RPC can register a watch at any point
 *    in here. That one is *not* solved by position: `restoreScenarioWatches`
 *    skips keys it already holds, in both passes. Keeping it out of the
 *    ordering is what lets 1 and 2 be satisfied independently.
 *
 * This pass also does the pruning: a row whose scenario is no longer loaded is
 * dropped here, once every path that could still load one has run.
 */
export function finishWatchSetup(
  fileReload: FileReloadManager | null,
  serverLog: (message: string) => void,
): void {
  fileReload?.restoreScenarioWatches();
  logWatchSummary(fileReload, serverLog);
}

/**
 * Report what `--watch` ended up watching.
 *
 * Logged after the fleet exists *and* after `runStartupScenario` has registered
 * whatever `--scenario` / `--scenario-template-file` loaded — those register
 * inside the bootstrap loop, so counting before it told an operator "0 file(s)"
 * about a daemon that was watching a scenario file (#314). An operator who sees
 * nothing reload can then tell "--watch is off" from "--watch is on and no file
 * is behind any of this daemon's state". A filesystem that cannot watch reports
 * itself separately, once, from FileWatcher.
 */
function logWatchSummary(
  fileReload: FileReloadManager | null,
  serverLog: (message: string) => void,
): void {
  if (!fileReload) return;
  const paths = fileReload.watchedPaths();
  serverLog(
    `Watch: enabled — re-reading ${paths.length} loaded file(s) on change (#314)` +
      (paths.length > 0 ? `: ${paths.join(", ")}` : ""),
  );
}
