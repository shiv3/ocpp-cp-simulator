export interface Frame {
  seq: number;
  cpId: string;
  action: string;
  payload: unknown;
}

interface WaitOptions {
  timeoutMs?: number;
}

interface WaitForCallOptions extends WaitOptions {
  cpId?: string;
  sinceSeq?: number;
}

const POLL_MS = 25;
const PORTS_SENTINEL = "E2E_CSMS_PORTS ";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isFrame(value: unknown): value is Frame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.seq === "number" &&
    typeof frame.cpId === "string" &&
    typeof frame.action === "string" &&
    "payload" in frame
  );
}

export class FrameLog {
  private readonly frames: Frame[] = [];

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(PORTS_SENTINEL)) return;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isFrame(parsed)) this.frames.push(parsed);
    } catch (_error) {
      return;
    }
  }

  all(): Frame[] {
    return [...this.frames];
  }

  byCp(cpId: string): Frame[] {
    return this.frames.filter((frame) => frame.cpId === cpId);
  }

  find(cpId: string, action: string): Frame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame.cpId === cpId && frame.action === action) return frame;
    }
    return undefined;
  }

  waitForCall(
    action: string,
    { cpId, sinceSeq, timeoutMs = 10_000 }: WaitForCallOptions = {},
  ): Promise<Frame> {
    return this.waitForFrameMatching(
      (frame) =>
        frame.action === action &&
        (cpId === undefined || frame.cpId === cpId) &&
        (sinceSeq === undefined || frame.seq > sinceSeq),
      timeoutMs,
      `call ${action}${cpId ? ` for cpId ${cpId}` : ""}`,
    );
  }

  waitForFrame(
    pred: (frame: Frame) => boolean,
    { timeoutMs = 10_000 }: WaitOptions = {},
  ): Promise<Frame> {
    return this.waitForFrameMatching(pred, timeoutMs, "matching frame");
  }

  private async waitForFrameMatching(
    pred: (frame: Frame) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const found = this.frames.find(pred);
      if (found) return found;
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${label}. Seen: ${this.describeSeen()}`,
    );
  }

  private describeSeen(): string {
    if (this.frames.length === 0) return "no frames";
    const recent = this.frames
      .slice(-20)
      .map((frame) => `#${frame.seq} ${frame.cpId} ${frame.action}`)
      .join(", ");
    return `${this.frames.length} frame(s); recent: ${recent}`;
  }
}
