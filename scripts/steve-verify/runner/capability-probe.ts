/**
 * capability-probe.ts -- issue #184 Task 4: startup capability detection.
 *
 * Prints, once per `run`/`run-all` CLI invocation, which of SteVe 3.13.0's
 * REST `/api/v1/**` surfaces this runner's REST driver (steve-api.ts)
 * relies on are actually live against the configured SteVe instance, and
 * which of this runner's known, SteVe-side, permanent gaps (juherr's issue
 * #184 Finding 3) are in effect -- so a run's console output states its own
 * fallback posture up front, in juherr's suggested shape, instead of a
 * reader inferring it from scattered WARN lines mid-run:
 *
 *   SteVe API operations: available
 *   Transaction API: available
 *   OCPP tag API: available
 *   Reservation query API: unavailable, using DB fallback (steve-community/steve#2074)
 *   Charge point provisioning API: unavailable, using DB fallback (steve-community/steve#2068)
 *   Charging Profile API: UI fallback (steve-community/steve#2069)
 *   Async task result lookup: unavailable (steve-community/steve#2070)
 *
 * Every check below is a single, side-effect-free HTTP call -- a GET with a
 * query filter guaranteed to match nothing real (transactions/ocppTags), a
 * GET at a path SteVe 3.13.0 has no controller for at all
 * (reservations/chargepoints/chargingProfiles), or a POST whose body is
 * deliberately invalid so SteVe 400s on request-DTO validation before ever
 * dispatching to a charge point (operations) -- see each probe*() function
 * below for the exact live-verified status code this repo's SteVe 3.13.0
 * instance returns for it (captured during this task's own verification
 * run, the same live-instance method Tasks 2/3 used).
 *
 * The three "known gap" checks are genuinely re-probed every run, not just
 * printed from a hardcoded string -- see probeUnavailable()'s doc comment
 * for why, and how this line self-corrects if a future SteVe version ships
 * one of these endpoints. The seventh line (async task result lookup) is
 * the one exception -- see probeCapabilities()'s comment on why it is
 * stated statically instead.
 *
 * Best-effort throughout: an HTTP failure (SteVe down, wrong
 * STEVE_API_URL, network error, timeout) reports "unknown" for that one
 * line and never throws -- this is informational output at the top of a
 * run, not a precondition for the run itself (which may be using
 * STEVE_DRIVER=ui regardless of what this probe finds, or may be the very
 * first invocation against a SteVe instance that isn't up yet).
 */

import { basicAuthHeader, defaultSteveApiConfig } from "./steve-api";
import type { SteveApiConfig } from "./steve-api";

/** Every check here is a single cheap GET/POST -- keep the startup probe
 *  snappy even against an unreachable/slow SteVe rather than stalling the
 *  run behind steve-api.ts's 40s operations budget. */
const PROBE_TIMEOUT_MS = 8_000;

/** Result of one raw HTTP probe call -- exported so the pure formatters
 *  below (formatAvailableLine/formatUnavailableLine) can be unit tested
 *  against synthetic outcomes without a live SteVe. */
export type ProbeOutcome =
  { kind: "http"; status: number } | { kind: "error"; message: string };

async function probeGet(
  cfg: SteveApiConfig,
  path: string,
): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      headers: {
        accept: "application/json",
        authorization: basicAuthHeader(cfg.username, cfg.password),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { kind: "http", status: res.status };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** POSTs a deliberately-invalid operations body (empty `chargeBoxIdList`) --
 *  live-verified against SteVe 3.13.0: the DTO's validation rejects an
 *  empty list with `400 {"error":"Bad Request","message":"Error
 *  understanding the request"}` BEFORE `OcppOperationsService#execute`
 *  ever runs, so no charge point is contacted. A 400 (or, if some future
 *  SteVe version relaxes that validation, any 2xx) both mean "the
 *  endpoint, auth, and request routing all work" -- see
 *  {@link formatAvailableLine}'s `isSuccess` predicate for this check. */
async function probeOperationsInvalid(
  cfg: SteveApiConfig,
): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`${cfg.baseUrl}/operations/GetConfiguration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: basicAuthHeader(cfg.username, cfg.password),
      },
      body: JSON.stringify({ chargeBoxIdList: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { kind: "http", status: res.status };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `401` on any of these probes means the request reached SteVe's `/api/**`
 *  filter chain but Basic auth itself failed -- distinct from a routing
 *  403/404, and worth a pointer to the specific known cause (see
 *  steve-api.ts's file header: `web_user.api_password` unseeded/stale, or
 *  wrong STEVE_API_USER/PASS) rather than a bare "unknown HTTP 401". Pure,
 *  exported for unit testing. */
export function authNote(status: number): string | undefined {
  if (status === 401) {
    return 'check STEVE_API_USER/STEVE_API_PASS, or web_user.api_password seeding -- see README\'s "Environment / configuration" section';
  }
  return undefined;
}

/** Formats one "available-by-design" probe line (operations/transactions/
 *  ocppTags -- steve-api.ts already drives these live, Tasks 2/3):
 *  "available" on the live-verified success signal, "unknown" (with a
 *  reason) on anything else, so a genuine outage or auth problem is
 *  visible instead of this probe silently claiming availability. Pure,
 *  exported for unit testing. */
export function formatAvailableLine(
  label: string,
  outcome: ProbeOutcome,
  isSuccess: (status: number) => boolean,
): string {
  if (outcome.kind === "error") {
    return `${label}: unknown (probe failed: ${outcome.message})`;
  }
  if (isSuccess(outcome.status)) {
    return `${label}: available`;
  }
  const note = authNote(outcome.status);
  return `${label}: unknown (unexpected HTTP ${outcome.status}${note ? ` -- ${note}` : ""})`;
}

/**
 * Formats one known-permanent-for-3.13.0-gap probe line (reservations /
 * charge point provisioning / charging profiles, issue #184 Finding 3):
 * SteVe 3.13.0 ships no controller at all for these resources (confirmed
 * by listing the running container's compiled `web/api/*RestController`
 * classes during Tasks 2/3 -- see steve-api.ts's file header), so its
 * security filter chain rejects any path outside its known
 * `/api/v1/{operations,transactions,ocppTags}/**` allow-list with a bare
 * `403`/`404` (live-verified: a raw Jetty error page for `403`, never even
 * reaching Spring's DispatcherServlet / the JSON error envelope the three
 * real controllers return for their own 4xxs) -- both status codes are
 * treated as "confirms the gap" here since either shape (filter-chain
 * reject vs. routing miss) proves the same thing: no such endpoint.
 *
 * Genuinely re-probed every run rather than a hardcoded string, so this
 * line self-corrects (flips to "available (!)") the day a future SteVe
 * version ships the endpoint -- worth surfacing even though none of Tasks
 * 1-3 expected it here. Pure, exported for unit testing.
 */
export function formatUnavailableLine(
  label: string,
  outcome: ProbeOutcome,
  fallback: string,
  issueRef: string,
): string {
  if (outcome.kind === "error") {
    return `${label}: unknown (probe failed: ${outcome.message})`;
  }
  const { status } = outcome;
  if (status === 403 || status === 404) {
    return `${label}: unavailable, using ${fallback} (${issueRef})`;
  }
  if (status >= 200 && status < 300) {
    return (
      `${label}: available (!) -- SteVe now appears to expose this endpoint; ` +
      `this runner's ${fallback} (tracked at ${issueRef}) may be retireable, worth a follow-up`
    );
  }
  const note = authNote(status);
  return `${label}: unknown (unexpected HTTP ${status}${note ? ` -- ${note}` : ""})`;
}

/** Full capability probe -- 7 lines, issue #184 Task 4 (juherr's suggested
 *  output shape, see the file header). Order matches the issue's own
 *  Finding 3 listing. */
export async function probeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const cfg = defaultSteveApiConfig(env);

  const [
    operations,
    transactions,
    ocppTags,
    reservations,
    chargepoints,
    chargingProfiles,
  ] = await Promise.all([
    probeOperationsInvalid(cfg).then((outcome) =>
      formatAvailableLine(
        "SteVe API operations",
        outcome,
        (status) => status === 400 || (status >= 200 && status < 300),
      ),
    ),
    probeGet(
      cfg,
      "/transactions?chargeBoxId=__steve-verify-capability-probe__",
    ).then((outcome) =>
      formatAvailableLine(
        "Transaction API",
        outcome,
        (status) => status >= 200 && status < 300,
      ),
    ),
    probeGet(cfg, "/ocppTags?idTag=__steve-verify-capability-probe__").then(
      (outcome) =>
        formatAvailableLine(
          "OCPP tag API",
          outcome,
          (status) => status >= 200 && status < 300,
        ),
    ),
    probeGet(cfg, "/reservations").then((outcome) =>
      formatUnavailableLine(
        "Reservation query API",
        outcome,
        "DB fallback",
        "steve-community/steve#2074",
      ),
    ),
    probeGet(cfg, "/chargepoints").then((outcome) =>
      formatUnavailableLine(
        "Charge point provisioning API",
        outcome,
        "DB fallback",
        "steve-community/steve#2068",
      ),
    ),
    probeGet(cfg, "/chargingProfiles").then((outcome) =>
      formatUnavailableLine(
        "Charging Profile API",
        outcome,
        "UI fallback",
        "steve-community/steve#2069",
      ),
    ),
  ]);

  return [
    operations,
    transactions,
    ocppTags,
    reservations,
    chargepoints,
    chargingProfiles,
    // Not probed live, unlike the six lines above: SteVe's operations API
    // is genuinely synchronous (OcppOperationsService blocks up to its own
    // 30s station-response timeout before responding at all -- see
    // steve-api.ts's file header) -- there is no separate "fetch this
    // taskId's result later" endpoint to probe. Reproducing the
    // taskFinished=false gap live would mean actually dispatching an
    // operation a real station answers silently to (Hard Reset today) at
    // a real charge point -- a ~30s, side-effecting call this startup
    // probe must never make. Stated statically instead -- this is issue
    // #184 Finding 3 / SteVe #2070, live-reproduced during Task 2 (see
    // steve-api.ts's file header for the Reset(Hard) capture) and already
    // handled by SteveApiOps#op() (WARN + return, never polled -- every
    // spec's assert() checks the sim's own wire log instead).
    "Async task result lookup: unavailable (steve-community/steve#2070)",
  ];
}

/** Prints the probe once per `run`/`run-all`/`run --group` CLI invocation
 *  (main.ts calls this at the very top of `main()`, before dispatching to
 *  either a single scenario or a group sweep) -- matches juherr's
 *  suggested startup-probe output shape (issue #184 Finding 3). Written to
 *  stderr, alongside every other `[runner]`-prefixed log line (stdout is
 *  reserved for PASS/FAIL check lines). Best-effort: never throws
 *  (probeCapabilities() already catches every per-check HTTP failure into
 *  an "unknown" line; the outer try/catch here is a last-resort net for a
 *  bug in the probe itself, not the expected path). */
export async function printCapabilityProbe(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  process.stderr.write("[runner] === SteVe capability probe ===\n");
  try {
    const lines = await probeCapabilities(env);
    for (const line of lines) {
      process.stderr.write(`[runner]   ${line}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[runner]   WARN: capability probe itself failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  process.stderr.write("[runner] === end capability probe ===\n\n");
}
