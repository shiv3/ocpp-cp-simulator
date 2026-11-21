import { OcppCallRejectedError } from "../errors/OcppCallErrors";
import type {
  ResponseOverrideRepeat,
  ResponseOverrideSpec,
} from "./ChargePointTypes";

export const RESPONSE_OVERRIDE_MODES = [
  "status",
  "callError",
  "callResult",
  "raw",
  "callResultError",
  "delay",
  "noAnswer",
] as const;

/** The longest answer delay a response override may ask for. */
export const RESPONSE_OVERRIDE_MAX_DELAY_MS = 600_000;

/**
 * A response override as the control plane (`set_response_override`) and the
 * `responseOverride` scenario node state it: flat, with `mode` choosing which
 * of the other fields apply. A request without `mode` is the original
 * one-shot `{ status }` override (#110).
 */
export interface ResponseOverrideRequest {
  readonly action: string;
  readonly mode?: (typeof RESPONSE_OVERRIDE_MODES)[number];
  readonly status?: string;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly errorDetails?: Record<string, unknown>;
  readonly payload?: unknown;
  readonly frame?: string;
  readonly delayMs?: number;
  readonly times?: number;
  readonly persistent?: boolean;
}

function invalid(message: string): never {
  throw new OcppCallRejectedError("invalid_payload", message);
}

/**
 * Turn a flat request into the spec the charge point arms. Refuses a mode
 * without the field it needs, and a field the mode does not use is ignored.
 */
export function buildResponseOverride(request: ResponseOverrideRequest): {
  spec: ResponseOverrideSpec;
  repeat: ResponseOverrideRepeat;
} {
  const mode = request.mode ?? "status";
  const { delayMs } = request;
  if (delayMs !== undefined) {
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      delayMs > RESPONSE_OVERRIDE_MAX_DELAY_MS
    ) {
      invalid(
        `delayMs must be 0 to ${RESPONSE_OVERRIDE_MAX_DELAY_MS} milliseconds`,
      );
    }
  }
  const delay = delayMs === undefined ? {} : { delayMs };
  const requireCode = (): string => {
    if (typeof request.errorCode !== "string" || request.errorCode === "") {
      invalid(`mode ${mode} needs an errorCode`);
    }
    return request.errorCode;
  };
  let spec: ResponseOverrideSpec;
  switch (mode) {
    case "status":
      if (typeof request.status !== "string" || request.status === "") {
        invalid("mode status needs a status");
      }
      spec = { mode, status: request.status, ...delay };
      break;
    case "callError":
    case "callResultError": {
      const errorCode = requireCode();
      spec = {
        mode,
        errorCode,
        ...(request.errorDescription === undefined
          ? {}
          : { errorDescription: request.errorDescription }),
        ...(request.errorDetails === undefined
          ? {}
          : { errorDetails: request.errorDetails }),
        ...delay,
      };
      break;
    }
    case "callResult":
      if (request.payload === undefined)
        invalid("mode callResult needs a payload");
      spec = { mode, payload: request.payload, ...delay };
      break;
    case "raw":
      if (typeof request.frame !== "string") invalid("mode raw needs a frame");
      spec = { mode, frame: request.frame, ...delay };
      break;
    case "delay":
      if (delayMs === undefined) invalid("mode delay needs delayMs");
      spec = { mode, delayMs };
      break;
    case "noAnswer":
      spec = { mode };
      break;
  }
  const { times, persistent } = request;
  if (times !== undefined && (!Number.isInteger(times) || times < 1)) {
    invalid("times must be a whole number of at least 1");
  }
  return {
    spec,
    repeat: {
      ...(times === undefined ? {} : { times }),
      ...(persistent === undefined ? {} : { persistent }),
    },
  };
}
