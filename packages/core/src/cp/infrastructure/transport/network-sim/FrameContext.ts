export type Direction = "upstream" | "downstream";

export interface FrameContext {
  direction: Direction;
  messageType?: number;
  action?: string;
  messageId?: string;
  byteSize: number;
}

export function parseFrameContext(
  raw: string,
  direction: Direction,
): FrameContext {
  const invalidContext: FrameContext = {
    direction,
    messageType: undefined,
    action: undefined,
    messageId: undefined,
    byteSize: new TextEncoder().encode(raw).byteLength,
  };

  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return invalidContext;
  }

  if (!Array.isArray(frame)) {
    return invalidContext;
  }

  const messageType = frame[0];
  const expectedLength =
    messageType === 2 ? 4 : messageType === 3 ? 3 : messageType === 4 ? 5 : 0;

  if (expectedLength === 0 || frame.length !== expectedLength) {
    return invalidContext;
  }

  return {
    direction,
    messageType,
    action:
      messageType === 2 && typeof frame[2] === "string" ? frame[2] : undefined,
    messageId: typeof frame[1] === "string" ? frame[1] : undefined,
    byteSize: invalidContext.byteSize,
  };
}
