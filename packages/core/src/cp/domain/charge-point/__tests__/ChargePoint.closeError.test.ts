import { describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { CloseCause } from "../../../infrastructure/transport/network-sim";

/**
 * #474: only a close the charge point did not ask for, with a code other
 * than 1000/1005, puts it in error.
 */
function connectedChargePoint() {
  const cp = new ChargePoint(
    "test-cp-close-error",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  let onclose: ((ev: CloseEvent, cause: CloseCause) => void) | null = null;
  vi.spyOn(cp["_webSocket"]!, "connect").mockImplementation((_open, close) => {
    onclose = close ?? null;
  });
  cp.connect();
  const errors: string[] = [];
  cp.events.on("error", ({ error }) => errors.push(error));
  const loggedErrors = vi.spyOn(cp["_logger"], "error");
  const close = (code: number, cause: CloseCause) =>
    onclose!(new CloseEvent("close", { code, reason: "bye" }), cause);
  return { cp, errors, loggedErrors, close };
}

describe("ChargePoint close → error (#474)", () => {
  it.each<[number, CloseCause]>([
    [1000, "network"],
    [1005, "network"],
    [1000, "manual"],
    [1006, "manual"],
    [1006, "internal"],
    [1000, "simulated"],
    [1006, "simulated"],
  ])("close %i (%s) is not an error", (code, cause) => {
    const { cp, errors, loggedErrors, close } = connectedChargePoint();

    close(code, cause);

    expect(cp.error).toBe("");
    expect(errors).toEqual([]);
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it.each([1001, 1006, 1011])("network close %i is an error", (code) => {
    const { cp, errors, loggedErrors, close } = connectedChargePoint();

    close(code, "network");

    const message = `WebSocket closed code: ${code} reason: bye`;
    expect(cp.error).toBe(message);
    expect(errors).toEqual([message]);
    expect(loggedErrors).toHaveBeenCalledWith(message, expect.anything());
  });

  it("keeps an earlier error through a later normal close", () => {
    const { cp, errors, close } = connectedChargePoint();

    close(1006, "network");
    close(1000, "manual");

    expect(cp.error).toBe("WebSocket closed code: 1006 reason: bye");
    expect(errors).toEqual(["WebSocket closed code: 1006 reason: bye"]);
  });

  it("still reports every close as disconnected", () => {
    const { cp, close } = connectedChargePoint();
    const disconnected: unknown[] = [];
    cp.events.on("disconnected", (data) => disconnected.push(data));

    close(1000, "manual");
    close(1006, "network");

    expect(disconnected).toEqual([
      { code: 1000, reason: "bye" },
      { code: 1006, reason: "bye" },
    ]);
  });
});
