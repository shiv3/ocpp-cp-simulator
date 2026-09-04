import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";

/**
 * The settled hook never runs inside the teardown that announced it (#314).
 *
 * This pins the guarantee at its source. Its only production consumer is
 * `FileReloadManager`, which now defers every drain of its own — so a
 * regression here would be invisible through the reload suite while still
 * being wrong for the next consumer. `notifySessionSettled` is where the rule
 * is expressed, so this is where it is tested.
 *
 * `resetScenario` is the sharpest probe: it announces the settle mid-method,
 * with connector work still to do afterwards, so a synchronous handler observes
 * a half-torn-down connector — and, because installing a definition can
 * auto-start a run, could start one against that state.
 */
describe("CLIChargePointService.onSessionSettled (#314)", () => {
  function service(): CLIChargePointService {
    return new CLIChargePointService({
      cpId: "cp-settled",
      wsUrl: "ws://127.0.0.1:1/never-connected",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });
  }

  it("announces on a later microtask, not inside the caller's stack", async () => {
    const svc = service();
    const seen: string[] = [];
    svc.onSessionSettled(() => seen.push("handler"));

    svc.resetScenario(1, "not-loaded");
    // Nothing yet: the announcement is queued, and `resetScenario` still has
    // connector state to clear after the point it announced from.
    expect(seen).toEqual([]);

    await Promise.resolve();
    expect(seen).toEqual(["handler"]);
    svc.cleanup(true);
  });

  it("skips a handler unsubscribed between the announcement and the drain", async () => {
    const svc = service();
    const seen: string[] = [];
    const unsubscribe = svc.onSessionSettled(() => seen.push("handler"));

    svc.resetScenario(1, "not-loaded");
    // The window the deferral opens, and the reason the handler set is
    // re-checked rather than captured: a service can be torn down between the
    // two turns.
    unsubscribe();

    await Promise.resolve();
    expect(seen).toEqual([]);
    svc.cleanup(true);
  });
});
