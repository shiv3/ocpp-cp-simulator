import type {
  Behavior,
  BehaviorContext,
  CallOutcome,
  BehaviorParams,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";
import { checkUploadUrl } from "../../../domain/charge-point/uploadUrl";
import { buildLogArtifact } from "./logArtifact";
import { MAX_LOG_UPLOAD_RETRIES, uploadWithRetries } from "./uploadRetry";

/** The knobs of the 1.6 upload; the default is the former constant. */
const PARAMS: BehaviorParams = {
  schema: {
    type: "object",
    properties: {
      uploadMs: {
        type: "integer",
        minimum: 0,
        maximum: 3_600_000,
        title: "Upload time (ms)",
        description: "Time between Uploading and Uploaded",
      },
      auto: {
        type: "boolean",
        title: "Automatic upload (OCPP 2.x)",
        description:
          "OCPP 2.x only: send Uploading and Uploaded after an accepted GetLog, and answer AcceptedCanceled to a GetLog that replaces an upload in progress (N01.FR.12). Off: acknowledge only, the control plane drives the notifications. OCPP 1.6 always uploads",
      },
    },
  },
  defaults: { uploadMs: 2000, auto: true },
};

interface GetLogRequest {
  logType?: string;
  requestId?: number;
  log?: {
    remoteLocation?: string;
    oldestTimestamp?: string;
    latestTimestamp?: string;
  };
  retries?: number;
  retryInterval?: number;
}

/**
 * The default behavior of GetLog.
 *
 * OCPP 1.6 Security Whitepaper: the response returns the log's file name,
 * then, once it settled, the station sends LogStatusNotification `Uploading`
 * and, two seconds later, `Uploaded`, both carrying `requestId`. There is no
 * real log to upload, so the sequence is timer-driven. A request that arrives
 * while an upload runs cancels it and is answered `AcceptedCanceled`
 * (whitepaper N01.FR.11): only the new request's `Uploaded` is sent.
 *
 * OCPP 2.x (N01): the request is accepted with a file name and, once the
 * answer settled, the station sends LogStatusNotification `Uploading` and,
 * `uploadMs` later, `Uploaded`, both carrying the request's `requestId`
 * (N01.FR.07 to FR.09; #601). A GetLog that arrives during an upload is
 * answered `AcceptedCanceled`; the upload it replaces ends with a
 * LogStatusNotification `AcceptedCanceled` for its own `requestId`
 * (N01.FR.12, FR.20) and never reports `Uploaded`. With `auto` off the
 * station reports nothing on its own and the control plane drives the
 * notifications, as before #601.
 */
export function logsBehavior(cp: ChargePoint): Behavior {
  /**
   * The real upload (#926), for both versions, when the operator switched
   * `RealLogUpload` on. Returns undefined when the simulated lifecycle applies
   * (2.x with `auto` off: the control plane drives the notifications).
   */
  const realUpload = (
    req: GetLogRequest,
    ctx: BehaviorContext,
  ): CallOutcome | undefined => {
    const v2 = isOcpp2Version(cp.ocppVersion);
    if (v2 && ctx.params.auto !== true) return undefined;
    const reject = (reasonCode: string, why: string): CallOutcome => {
      cp.logger.warn(
        `GetLog request ${req.requestId} rejected: ${why}`,
        LogType.DIAGNOSTICS,
      );
      return {
        response: v2
          ? {
              status: "Rejected",
              statusInfo: { reasonCode, additionalInfo: why },
            }
          : { status: "Rejected" },
      };
    };
    const logType = req.logType ?? "DiagnosticsLog";
    // The simulator keeps no security log: a SecurityLog request must not
    // get the diagnostics file under that label.
    if (logType !== "DiagnosticsLog") {
      return reject(
        "UnsupportedParam",
        `logType ${logType} is not supported; only DiagnosticsLog`,
      );
    }
    const verdict = checkUploadUrl(
      req.log?.remoteLocation ?? "",
      cp.configuration.getBoolean("LogUploadAllowPrivateHosts") === true,
    );
    if (!verdict.ok) return reject("InvalidURL", verdict.reason);
    const location = verdict.url.toString();
    const requestId = req.requestId ?? 0;
    if (v2 && typeof req.requestId === "number") {
      cp.noteLogRequest(req.requestId);
    }
    const previous = ctx.state.uploadingRequestId;
    const replaces = previous !== undefined && previous !== null;
    const seqAtRequest = cp.logStatusSeq;
    // Taken now, with the answer: the replaced upload stops reporting from
    // this point (#846).
    const generation =
      (typeof ctx.state.uploadGeneration === "number"
        ? ctx.state.uploadGeneration
        : 0) + 1;
    ctx.state.uploadGeneration = generation;
    const fileName = `${cp.id}-${logType}-${requestId}.jsonl`.slice(-255);
    // The snapshot is taken now, before the asynchronous upload and its retries.
    const artifact = buildLogArtifact(cp, fileName, req.log ?? {});
    cp.logger.info(
      `GetLog ${requestId}: uploading ${artifact.entries} log entries (${artifact.truncated} truncated)`,
      LogType.DIAGNOSTICS,
    );
    return {
      response: {
        status: replaces ? "AcceptedCanceled" : "Accepted",
        filename: fileName,
      },
      after: async (): Promise<void> => {
        let seenSeq = seqAtRequest;
        // Another sender of this request's status train takes it over.
        const driven = (): boolean =>
          cp.logStatusSeq !== seenSeq &&
          cp.lastLogStatusRequestId === requestId;
        if (v2 && typeof previous === "number") {
          // N01.FR.20: the cancelled upload reports it.
          ctx.notify.logStatus("AcceptedCanceled", { requestId: previous });
          if (!driven()) seenSeq = cp.logStatusSeq;
        }
        ctx.state.uploadingRequestId = requestId;
        const send = (status: string): void => {
          ctx.notify.logStatus(status, { requestId });
          seenSeq = cp.logStatusSeq;
        };
        try {
          if (!driven()) send("Uploading");
          const done = await uploadWithRetries({
            cp,
            ctx,
            upload: cp.logUploader,
            location,
            file: artifact.file,
            retries: req.retries,
            retryInterval: req.retryInterval,
            maxRetries: MAX_LOG_UPLOAD_RETRIES,
            label: "Log",
            superseded: () =>
              ctx.stopping ||
              ctx.state.uploadGeneration !== generation ||
              driven(),
          });
          if (done === "superseded") return;
          // Uploaded only after the server accepted the file.
          send(done ? "Uploaded" : "UploadFailure");
        } finally {
          if (ctx.state.uploadGeneration === generation) {
            ctx.state.uploadingRequestId = null;
          }
        }
      },
    };
  };

  return {
    api: 1,
    id: "default.logs",
    params: PARAMS,
    onCall: {
      GetLog: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = (request ?? {}) as GetLogRequest;
          if (cp.configuration.getBoolean("RealLogUpload") === true) {
            const real = realUpload(req, ctx);
            if (real) return real;
          }
          if (isOcpp2Version(cp.ocppVersion)) {
            if (typeof req.requestId === "number") {
              cp.noteLogRequest(req.requestId);
            }
            const logType = req.logType ?? "DiagnosticsLog";
            const auto = ctx.params.auto === true;
            const previous = ctx.state.uploadingRequestId;
            const replaces =
              auto && previous !== undefined && previous !== null;
            const seqAtRequest = cp.logStatusSeq;
            // Taken now, with the answer: the old upload stops reporting from
            // this point, so it cannot send Uploaded after this request was
            // answered AcceptedCanceled (#846).
            let generation = 0;
            if (auto) {
              generation =
                (typeof ctx.state.uploadGeneration === "number"
                  ? ctx.state.uploadGeneration
                  : 0) + 1;
              ctx.state.uploadGeneration = generation;
            }
            return {
              response: {
                status: replaces ? "AcceptedCanceled" : "Accepted",
                // GetLogResponse.filename is bounded at 255 in the 2.0.1 schema.
                filename: `${cp.id}-${logType}-${req.requestId ?? 0}.log`.slice(
                  -255,
                ),
              },
              after: auto
                ? async (): Promise<void> => {
                    const requestId = req.requestId ?? 0;
                    // Another sender of this request's status train (the
                    // control plane, a scenario `notify` node) takes the
                    // lifecycle over: it sends nothing more (N01.FR.09).
                    let seenSeq = seqAtRequest;
                    const driven = (): boolean =>
                      cp.logStatusSeq !== seenSeq &&
                      cp.lastLogStatusRequestId === requestId;
                    if (typeof previous === "number") {
                      // N01.FR.20: the cancelled upload reports it.
                      ctx.notify.logStatus("AcceptedCanceled", {
                        requestId: previous,
                      });
                      if (!driven()) seenSeq = cp.logStatusSeq;
                    }
                    ctx.state.uploadingRequestId = requestId;
                    const send = (status: "Uploading" | "Uploaded"): void => {
                      ctx.notify.logStatus(status, { requestId });
                      seenSeq = cp.logStatusSeq;
                    };
                    try {
                      if (!driven()) send("Uploading");
                      await ctx.sleep(ctx.params.uploadMs as number);
                      if (
                        ctx.stopping ||
                        ctx.state.uploadGeneration !== generation ||
                        driven()
                      ) {
                        return;
                      }
                      send("Uploaded");
                    } finally {
                      if (ctx.state.uploadGeneration === generation) {
                        ctx.state.uploadingRequestId = null;
                      }
                    }
                  }
                : undefined,
            };
          }

          cp.logger.info(
            `GetLog request received: logType=${req.logType} requestId=${req.requestId}`,
            LogType.DIAGNOSTICS,
          );
          // N01.FR.11 / L01.FR.26: a request while an upload runs cancels it
          // and is answered AcceptedCanceled. Taking the next run number is
          // the cancellation: the old upload sends nothing more.
          const cancelsRunning = ctx.state.inFlight === true;
          const run = Number(ctx.state.run ?? 0) + 1;
          ctx.state.run = run;
          return {
            response: {
              status: cancelsRunning ? "AcceptedCanceled" : "Accepted",
              filename: `${cp.id}-${req.logType}-${req.requestId}.log`,
            },
            // Status notifications follow the CALLRESULT, never precede it.
            after: async (): Promise<void> => {
              if (ctx.state.run !== run) return;
              ctx.state.inFlight = true;
              try {
                ctx.notify.logStatus("Uploading", { requestId: req.requestId });
                await ctx.sleep(ctx.params.uploadMs as number);
                if (ctx.state.run !== run) return;
                ctx.notify.logStatus("Uploaded", { requestId: req.requestId });
              } finally {
                if (ctx.state.run === run) ctx.state.inFlight = false;
              }
            },
          };
        },
      },
    },
  };
}
