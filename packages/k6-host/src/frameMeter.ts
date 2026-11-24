// Turns the OCPP-J text frames of one charge point into load-test events,
// straight from the frame observer (`ChargePoint.onWireFrame`): no log line is
// parsed. A CALL the station sends is counted and timed until the CALLRESULT /
// CALLERROR with the same message id arrives; a CALL the CSMS sends is counted.

export interface FrameEvents {
  /** The station sent a CALL. */
  call(action: string): void;
  /** The CSMS answered a CALL of the station; `error` for a CALLERROR. */
  result(action: string, durationMs: number, error: boolean): void;
  /** The CSMS sent a CALL to the station. */
  csmsCall(action: string): void;
}

// [<type>,"<id>"(,"<action>")?  — the head of every OCPP-J frame.
const HEAD =
  /^\[\s*(\d)\s*,\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"([A-Za-z0-9_]+)")?/;

/** Pending CALLs older than this are forgotten (a CSMS that never answers). */
const MAX_PENDING = 512;

export class FrameMeter {
  private readonly pending = new Map<string, { action: string; at: number }>();

  constructor(
    private readonly events: FrameEvents,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed one frame; `direction` is from the station's point of view. */
  observe(direction: "sent" | "received", raw: string): void {
    const m = HEAD.exec(raw);
    if (!m) return;
    const type = m[1];
    const id = m[2]!;
    if (direction === "sent") {
      if (type === "2" && m[3]) {
        if (this.pending.size >= MAX_PENDING) {
          const oldest = this.pending.keys().next().value;
          if (oldest !== undefined) this.pending.delete(oldest);
        }
        this.pending.set(id, { action: m[3], at: this.now() });
        this.events.call(m[3]);
      }
      return;
    }
    if (type === "2" && m[3]) {
      this.events.csmsCall(m[3]);
    } else if (type === "3" || type === "4") {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      this.events.result(call.action, this.now() - call.at, type === "4");
    }
  }
}
