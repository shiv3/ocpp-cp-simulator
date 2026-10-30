import { OcppCallNoAnswerError } from "../errors/OcppCallErrors";
import {
  OCPP_CALL_RESPONSE_TIMEOUT_MS,
  type OcppCallOutcome,
} from "../types/OcppCall";

/**
 * OCPP 2.0.1 / 2.1 Get15118EVCertificate (M01 certificate installation, M02
 * certificate update, #537). A station relays an EV's ISO 15118
 * CertificateInstallationReq / CertificateUpdateReq to the CSMS and hands
 * the CSMS's EXI answer back to the EV. The simulator has no EV and no EXI
 * codec, so the caller supplies the EXI request and receives the answers:
 * the station only relays.
 */
export interface Get15118EVCertificateRequest {
  readonly iso15118SchemaVersion: string;
  readonly action: "Install" | "Update";
  /** Base64 EXI, sent as given. */
  readonly exiRequest: string;
  /** 2.1, ISO 15118-20 sessions only (M01.FR.02/03). Its presence makes the
   *  station repeat the request while contracts remain (M01.FR.06). */
  readonly maximumContractCertificateChains?: number;
  /** 2.1, ISO 15118-20 sessions only. */
  readonly prioritizedEMAIDs?: string[];
}

export interface Get15118EVCertificateResult {
  /** Every CALLRESULT payload, in order, as the CSMS sent it. */
  readonly responses: readonly unknown[];
  /** The CSMS answered the last request with a CALLERROR. */
  readonly callError?: {
    readonly errorCode: string;
    readonly errorDescription: string;
    readonly errorDetails: unknown;
  };
  /** A repeated request got no answer; `responses` holds the earlier ones. */
  readonly noAnswer?: "timeout" | "dropped";
}

export interface RelayOptions {
  /** Time allowed for every request together. Default: one CALL's
   *  timeout, so a remote caller sees the relay's own answer before the
   *  Socket.IO client gives up. */
  readonly budgetMs?: number;
  readonly warn?: (message: string) => void;
}

/** The request payload, absent optional fields left out. */
export function get15118EVCertificatePayload(
  request: Get15118EVCertificateRequest,
): Record<string, unknown> {
  return {
    iso15118SchemaVersion: request.iso15118SchemaVersion,
    action: request.action,
    exiRequest: request.exiRequest,
    ...(request.maximumContractCertificateChains !== undefined
      ? {
          maximumContractCertificateChains:
            request.maximumContractCertificateChains,
        }
      : {}),
    ...(request.prioritizedEMAIDs !== undefined
      ? { prioritizedEMAIDs: request.prioritizedEMAIDs }
      : {}),
  };
}

function remainingContractsOf(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { status, remainingContracts } = payload as Record<string, unknown>;
  if (status !== "Accepted") return undefined;
  return typeof remainingContracts === "number" &&
    Number.isInteger(remainingContracts) &&
    remainingContracts > 0
    ? remainingContracts
    : undefined;
}

/**
 * Sends the request through `send` and collects the CSMS's answers. An
 * ISO 15118-2 request (no `maximumContractCertificateChains`) is sent once.
 * An ISO 15118-20 one is sent again, unchanged, while an `Accepted` answer
 * says `remainingContracts` > 0 (2.1 M01.FR.06). The repetition stops early
 * when `remainingContracts` does not go down (M01.FR.07 has the CSMS
 * decrease it), after `maximumContractCertificateChains` requests (at least
 * one), on a CALLERROR, and when the time budget runs out.
 *
 * A first request that gets no answer throws {@link OcppCallNoAnswerError};
 * a later one ends the relay with `noAnswer` and the answers already had.
 * A refusal before sending (an invalid payload, for one) propagates.
 */
export async function relayGet15118EVCertificate(
  request: Get15118EVCertificateRequest,
  send: (payload: Record<string, unknown>) => Promise<OcppCallOutcome>,
  options: RelayOptions = {},
): Promise<Get15118EVCertificateResult> {
  const budgetMs = options.budgetMs ?? OCPP_CALL_RESPONSE_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const payload = get15118EVCertificatePayload(request);
  const maxRequests = Math.max(
    1,
    request.maximumContractCertificateChains ?? 1,
  );
  const responses: unknown[] = [];
  let previousRemaining: number | undefined;

  for (;;) {
    let outcome: OcppCallOutcome;
    try {
      outcome = await withinBudget(send(payload), deadline - Date.now());
    } catch (err) {
      if (err instanceof OcppCallNoAnswerError && responses.length > 0) {
        return { responses, noAnswer: err.reason };
      }
      throw err;
    }
    if (outcome.kind === "callError") {
      return {
        responses,
        callError: {
          errorCode: outcome.errorCode,
          errorDescription: outcome.errorDescription,
          errorDetails: outcome.errorDetails,
        },
      };
    }
    responses.push(outcome.payload);

    if (request.maximumContractCertificateChains === undefined) break;
    const remaining = remainingContractsOf(outcome.payload);
    if (remaining === undefined || responses.length >= maxRequests) break;
    if (previousRemaining !== undefined && remaining >= previousRemaining) {
      options.warn?.(
        `Get15118EVCertificate: remainingContracts did not decrease (${previousRemaining} then ${remaining}); not asking again`,
      );
      break;
    }
    previousRemaining = remaining;
    // A request sent with no time left could only time out.
    if (Date.now() >= deadline) return { responses, noAnswer: "timeout" };
  }
  return { responses };
}

/** `operation`, or an {@link OcppCallNoAnswerError} timeout after `ms`. */
function withinBudget<T>(operation: Promise<T>, ms: number): Promise<T> {
  // The CALL keeps its own timer; once the budget wins, its late outcome
  // is no longer anyone's to handle.
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OcppCallNoAnswerError(
            "timeout",
            "Get15118EVCertificate: no answer within the relay's time budget",
          ),
        ),
      Math.max(0, ms),
    );
  });
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer));
}
