import type { Frame } from "../../cp/application/verification/ocpp";
import type { WireFrame } from "./FakeCsms";

/**
 * The frames of a fake-CSMS recording, as the daemon's transcript holds them
 * (what `evaluateAssertions` reads): `CP>` is sent, `CSMS>` received.
 */
export function toFrames(frames: readonly WireFrame[]): Frame[] {
  return frames.flatMap((f, i): Frame[] => {
    const direction = f.dir === "CP>" ? "sent" : "received";
    const base = {
      direction,
      uniqueId: f.id,
      payload: f.payload,
      timestamp: new Date(i * 1000).toISOString(),
      raw: JSON.stringify(f),
    } as const;
    if (f.kind === "call") {
      return [{ kind: "call", action: f.action ?? "", ...base }];
    }
    if (f.kind === "result") return [{ kind: "callresult", ...base }];
    return [];
  });
}
