import { afterEach, describe, expect, it } from "bun:test";

import { parseArgs } from "../cli/parseArgs";
import { CLIChargePointService, type CLIEvent } from "../service";
import {
  startMockCsms,
  type MockCsms,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";

/**
 * The standalone runtime (`--json` and the REPL) builds its charge point with
 * `CLIChargePointService.fromOptions`; the `--reconnect-*` flags must reach it
 * as they do the daemon's charge points.
 */
const csmsList: MockCsms[] = [];
const services: CLIChargePointService[] = [];

afterEach(async () => {
  for (const svc of services.splice(0)) svc.cleanup();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

async function until(done: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(10);
}

describe("CLIChargePointService.fromOptions transport flags", () => {
  it("--reconnect-max-attempts 0 gives up instead of reconnecting", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const options = parseArgs([
      "bun",
      "main.ts",
      "--cp-id",
      "cp-transport",
      "--ws-url",
      csms.url,
      "--reconnect-max-attempts",
      "0",
    ]);
    const svc = CLIChargePointService.fromOptions(options, null);
    services.push(svc);
    const events: CLIEvent[] = [];
    svc.onEvent((evt) => events.push(evt));

    await svc.connect();
    await csms.waitForCall("BootNotification");
    csms.closeCurrentConnection(1011);

    const kinds = () =>
      events
        .filter((evt) => evt.event === "timeline_entry")
        .map((evt) => (evt.data as { kind: string }).kind);
    await until(() => kinds().includes("gave_up"));
    expect(kinds()).toContain("gave_up");
    expect(kinds()).not.toContain("reconnecting");
  });
});
