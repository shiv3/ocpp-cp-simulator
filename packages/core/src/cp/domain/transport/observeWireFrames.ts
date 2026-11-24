import type { ChargePointSocket } from "./ChargePointSocket";

/** `sent` / `received` and the text frame as the socket wrote or read it. */
export type WireFrameListener = (
  direction: "sent" | "received",
  raw: string,
) => void;

/**
 * Observe the OCPP-J text frames a socket writes and reads (after the network
 * simulation released them): the direct alternative to parsing `Sent:` /
 * `Received:` log lines, so a load-test host counts frames without enabling
 * INFO logging. A SOAP charge point has no socket and no frames. Returns the
 * unsubscribe function.
 */
export function observeWireFrames(
  socket: ChargePointSocket | null,
  listener: WireFrameListener,
): () => void {
  if (!socket) return () => undefined;
  const { observers } = socket;
  const offs = [
    observers.on("frameSent", ({ raw }) => listener("sent", raw)),
    observers.on("frameReceived", ({ raw }) => listener("received", raw)),
  ];
  return () => offs.forEach((off) => off());
}
