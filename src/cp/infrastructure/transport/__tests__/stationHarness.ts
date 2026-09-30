// Test-only helpers for bun tests that drive a real ChargePoint against the
// mock CSMS (#348 DataTransfer, #389 expert calls).
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import type { MockCsms, OcppFrame } from "./mockCsms";

export const callOf = (action: string) => (frame: OcppFrame) =>
  frame[0] === 2 && frame[2] === action;

export const callsOf = (csms: MockCsms, action: string): OcppFrame[] =>
  csms.received.filter(callOf(action));

/**
 * A charge point connected to `csms`, its BootNotification answered with
 * `bootStatus`. When Accepted, returns once the boot gate is open: the
 * StatusNotification the station sends next is the sign it is. SOAP
 * stations are returned unconnected.
 */
export async function bootedChargePoint(
  csms: MockCsms,
  id: string,
  version: string,
  options: { connectors?: number; bootStatus?: "Accepted" | "Pending" } = {},
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    options.connectors ?? 1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  if (version === "OCPP-1.6S") return cp;
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  const bootStatus = options.bootStatus ?? "Accepted";
  csms.replyCallResult(boot.messageId, {
    status: bootStatus,
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  if (bootStatus === "Accepted") {
    await csms.waitForFrame(callOf("StatusNotification"));
  }
  return cp;
}

/**
 * Answer every CALL but BootNotification and the ones `skip` matches with an
 * empty CALLRESULT, so 1.6's strictly serial CALL queue (#176) keeps moving.
 * Returns the function that stops answering.
 */
export function answerEverythingElse(
  csms: MockCsms,
  skip: readonly string[] | ((frame: OcppFrame) => boolean),
): () => void {
  const skipped =
    typeof skip === "function"
      ? skip
      : (frame: OcppFrame) => skip.includes(frame[2] as string);
  const answered = new Set<string>();
  const tick = setInterval(() => {
    for (const frame of csms.received) {
      if (frame[0] !== 2) continue;
      const id = frame[1] as string;
      if (answered.has(id) || skipped(frame)) continue;
      answered.add(id);
      if (frame[2] === "BootNotification") continue;
      csms.replyCallResult(id, {});
    }
  }, 5);
  return () => clearInterval(tick);
}
