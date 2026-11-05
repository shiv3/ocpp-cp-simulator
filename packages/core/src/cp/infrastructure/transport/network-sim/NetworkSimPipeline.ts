export type FrameDropReason =
  "socket_closed" | "disposed" | "write_failed" | "queue_overflow";

export type CloseCause = "network" | "simulated" | "manual" | "internal";

export type Settlement =
  | { outcome: "written" }
  | { outcome: FrameDropReason; closeCause?: CloseCause };

export const PIPELINE_BUDGET = {
  maxFrames: 512,
  maxBytes: 2_097_152,
} as const;

type QueuedFrame = {
  raw: string;
  byteSize: number;
  dueAt: number;
  onSettled?: (settlement: Settlement) => void;
};

type PipelineOptions = {
  onDiscard?: (raw: string, settlement: Settlement) => void;
};

const textEncoder = new TextEncoder();

/**
 * Sinks and settlement callbacks are custody callbacks: they must not re-enter
 * enqueue()/shutdown() expecting the nested lifecycle operation to complete the
 * current frame synchronously. Lifecycle state is updated before callbacks run;
 * an in-flight frame whose sink calls shutdown() settles once after the sink returns.
 */
export class NetworkSimPipeline {
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  public constructor(
    private readonly sink: (raw: string) => void,
    private readonly opts: PipelineOptions = {},
  ) {}

  public get size(): number {
    return this.queue.length;
  }

  // Returns false when the frame is not accepted, including budget overflow or
  // a stopped pipeline. Rejected frames never settle and do not invoke onDiscard;
  // the transport boundary owns protocol-specific rejection handling, including
  // constructing queue_overflow settlements and logging downstream discards.
  public enqueue(
    raw: string,
    delayMs: number,
    onSettled?: (settlement: Settlement) => void,
  ): boolean {
    if (this.stopped) {
      return false;
    }

    const byteSize = textEncoder.encode(raw).byteLength;
    if (
      this.queue.length + 1 > PIPELINE_BUDGET.maxFrames ||
      this.queuedBytes + byteSize > PIPELINE_BUDGET.maxBytes
    ) {
      return false;
    }

    if (delayMs === 0 && this.queue.length === 0) {
      this.write(raw, onSettled);
      return true;
    }

    const frame: QueuedFrame = {
      raw,
      byteSize,
      dueAt: Date.now() + delayMs,
      onSettled,
    };
    this.queue.push(frame);
    this.queuedBytes += byteSize;

    if (this.queue.length === 1) {
      this.scheduleHead();
    }

    return true;
  }

  public shutdown(settlement: {
    reason: "socket_closed" | "disposed";
    closeCause?: CloseCause;
  }): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const drainedSettlement: Settlement = {
      outcome: settlement.reason,
      closeCause: settlement.closeCause,
    };

    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame === undefined) {
        break;
      }

      // Keep byte accounting correct before invoking re-entrant user callbacks.
      this.queuedBytes -= frame.byteSize;
      this.notify(frame.raw, frame.onSettled, drainedSettlement);
    }
  }

  private scheduleHead(): void {
    if (this.stopped || this.timer !== undefined) {
      return;
    }

    const head = this.queue[0];
    if (head === undefined) {
      return;
    }

    // Exactly one timer follows the current FIFO head's snapshotted deadline.
    this.timer = setTimeout(
      () => this.releaseHead(),
      Math.max(0, head.dueAt - Date.now()),
    );
  }

  private releaseHead(): void {
    this.timer = undefined;
    if (this.stopped) {
      return;
    }

    const head = this.queue[0];
    if (head === undefined) {
      return;
    }

    const remaining = head.dueAt - Date.now();
    if (remaining > 0) {
      this.timer = setTimeout(() => this.releaseHead(), remaining);
      return;
    }

    const frame = this.queue.shift();
    if (frame === undefined) {
      return;
    }
    this.queuedBytes -= frame.byteSize;
    this.write(frame.raw, frame.onSettled);
    this.scheduleHead();
  }

  private write(
    raw: string,
    onSettled?: (settlement: Settlement) => void,
  ): void {
    let settlement: Settlement;
    try {
      this.sink(raw);
      settlement = { outcome: "written" };
    } catch {
      settlement = { outcome: "write_failed" };
    }

    this.notify(raw, onSettled, settlement);
  }

  private notify(
    raw: string,
    onSettled: ((settlement: Settlement) => void) | undefined,
    settlement: Settlement,
  ): void {
    try {
      if (onSettled !== undefined) {
        onSettled(settlement);
      } else if (settlement.outcome !== "written") {
        this.opts.onDiscard?.(raw, settlement);
      }
    } catch {
      // Custody callback failures must not interrupt release or shutdown drain.
    }
  }
}
