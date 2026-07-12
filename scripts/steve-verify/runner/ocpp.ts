/**
 * ocpp.ts -- OCPP-J wire-frame parser + uniqueId correlation.
 *
 * The simulator CLI (src/cli/main.ts --json) does not emit a structured
 * event carrying raw OCPP frames: ChargePointEvents declares `messageSent`
 * / `messageReceived` payloads shaped exactly for this, but nothing in the
 * codebase ever emits them (see the Task 1 investigation notes in
 * .superpowers/sdd/tsr-task-1-report.md). What IS always present, JSON
 * mode or not, is the plain-text line the shared Logger writes straight to
 * console for every WebSocket frame:
 *
 *   [<iso-timestamp>] [<LEVEL>] [WebSocket] Sent: [2,"<uniqueId>","<Action>",{...}]
 *   [<iso-timestamp>] [<LEVEL>] [WebSocket] Received: [3,"<uniqueId>",{...}]
 *
 * This module parses that line format into typed frames and correlates a
 * request to its response by OCPP-J `uniqueId` -- not by "next matching
 * line within N lines of the request" (the bash predecessor's
 * check_response_status / check_sent_result window-scan), which can pick
 * up the wrong CALLRESULT when other traffic (StatusNotification, a second
 * concurrent op, ...) is interleaved on the wire between a request and its
 * own response.
 */

export type Direction = "sent" | "received";

export interface CallFrame {
  kind: "call";
  direction: Direction;
  uniqueId: string;
  action: string;
  payload: unknown;
  timestamp: string;
  raw: string;
}

export interface CallResultFrame {
  kind: "callresult";
  direction: Direction;
  uniqueId: string;
  payload: unknown;
  timestamp: string;
  raw: string;
}

export interface CallErrorFrame {
  kind: "callerror";
  direction: Direction;
  uniqueId: string;
  errorCode: string;
  errorDescription: string;
  errorDetails: unknown;
  timestamp: string;
  raw: string;
}

export type ResponseFrame = CallResultFrame | CallErrorFrame;
export type Frame = CallFrame | CallResultFrame | CallErrorFrame;

// `[<timestamp>] [<LEVEL>] [<Type>] <rest>` -- the Logger's plain-format
// line (src/cp/shared/Logger.ts formatLogEntry). Only WebSocket-typed lines
// ever carry "Sent:"/"Received:", but matching on the prefix generally
// keeps this parser agnostic to which LogType wrote it.
const LOG_LINE_RE = /^\[([^\]]+)\]\s+\[[^\]]+\]\s+\[[^\]]+\]\s+(.*)$/;
const FRAME_MESSAGE_RE = /^(Sent|Received):\s+(\[.*\])\s*$/;

/**
 * Parses a single stdout line from the simulator CLI into a {@link Frame},
 * or returns null for anything that isn't an OCPP-J Sent/Received line
 * (structured JSON events, JSON command responses, other log lines, blank
 * lines).
 */
export function parseLogLine(line: string): Frame | null {
  const lineMatch = LOG_LINE_RE.exec(line);
  if (!lineMatch) return null;
  const [, timestamp, rest] = lineMatch;

  const frameMatch = FRAME_MESSAGE_RE.exec(rest);
  if (!frameMatch) return null;
  const direction: Direction = frameMatch[1] === "Sent" ? "sent" : "received";

  let parsed: unknown;
  try {
    parsed = JSON.parse(frameMatch[2]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "number") return null;

  const messageTypeId = parsed[0];
  const uniqueId = String(parsed[1] ?? "");
  if (!uniqueId) return null;

  switch (messageTypeId) {
    case 2: {
      if (parsed.length < 4 || typeof parsed[2] !== "string") return null;
      return {
        kind: "call",
        direction,
        uniqueId,
        action: parsed[2],
        payload: parsed[3],
        timestamp,
        raw: line,
      };
    }
    case 3: {
      if (parsed.length < 3) return null;
      return {
        kind: "callresult",
        direction,
        uniqueId,
        payload: parsed[2],
        timestamp,
        raw: line,
      };
    }
    case 4: {
      if (parsed.length < 5 || typeof parsed[2] !== "string") return null;
      return {
        kind: "callerror",
        direction,
        uniqueId,
        errorCode: parsed[2],
        errorDescription: String(parsed[3] ?? ""),
        errorDetails: parsed[4],
        timestamp,
        raw: line,
      };
    }
    default:
      return null;
  }
}

/** Parses a whole multi-line log (or stdout capture), preserving order. */
export function parseLog(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split("\n")) {
    const frame = parseLogLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Finds the `occurrence`-th (0-indexed, default 0) CALL frame matching
 * `direction` + `action`, in log order.
 */
export function findCall(
  frames: readonly Frame[],
  direction: Direction,
  action: string,
  occurrence = 0,
): CallFrame | undefined {
  let seen = 0;
  for (const frame of frames) {
    if (
      frame.kind === "call" &&
      frame.direction === direction &&
      frame.action === action
    ) {
      if (seen === occurrence) return frame;
      seen++;
    }
  }
  return undefined;
}

/** Returns every CALL frame matching `direction` + `action`, in log order. */
export function findAllCalls(
  frames: readonly Frame[],
  direction: Direction,
  action: string,
): CallFrame[] {
  return frames.filter(
    (f): f is CallFrame =>
      f.kind === "call" && f.direction === direction && f.action === action,
  );
}

/**
 * Finds the CALLRESULT/CALLERROR that answers `call`, correlated strictly
 * by OCPP-J `uniqueId` and reply direction (a response to a sent CALL must
 * be received, and vice versa) -- never by adjacency in the log. Returns
 * the FIRST such response in log order (an OCPP peer should never send two
 * responses to the same uniqueId, but this is deterministic either way).
 */
export function findResponseFor(
  frames: readonly Frame[],
  call: CallFrame,
): ResponseFrame | undefined {
  const responseDirection: Direction =
    call.direction === "sent" ? "received" : "sent";
  for (const frame of frames) {
    if (
      (frame.kind === "callresult" || frame.kind === "callerror") &&
      frame.direction === responseDirection &&
      frame.uniqueId === call.uniqueId
    ) {
      return frame;
    }
  }
  return undefined;
}
