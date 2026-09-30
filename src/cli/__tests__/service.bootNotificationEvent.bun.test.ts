import { afterEach, describe, expect, it } from "bun:test";

import { CLIChargePointService, type CLIEvent } from "../service";
import type { RegistrationStatus } from "../../cp/domain/charge-point/ChargePointEvents";
import {
  startMockCsms,
  type MockCsms,
} from "../../cp/infrastructure/transport/__tests__/mockCsms";
import { testCpInit } from "./testCpInit";

/**
 * #395: the control plane must say, in so many words, what the CSMS answered
 * to BootNotification. `connected` only means the WebSocket opened — it fires
 * before BootNotification.req is even sent — and `status_change` fires on
 * occasions that are not boots at all, so neither lets an orchestrator tell
 * "Booting" from "Online".
 *
 * Each case drives a real WebSocket against a mock CSMS and answers the boot
 * by hand, so the event is only ever the product of a processed
 * BootNotification.conf.
 */
const CURRENT_TIME = "2026-09-30T12:00:00.000Z";

const services: { svc: CLIChargePointService; events: CLIEvent[] }[] = [];
const csmsList: MockCsms[] = [];

async function until(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(10);
}

afterEach(async () => {
  // Wait for the service to see the CSMS close before cleanup(): the close
  // handler sets the charge point's error, and an "error" emitted with no
  // listener left logs an unhandled-error trace into the test output.
  while (csmsList.length > 0) await csmsList.pop()?.stop();
  for (const { svc, events } of services.splice(0)) {
    await until(() => events.some((evt) => evt.event === "disconnected"));
    svc.cleanup();
  }
});

async function bootWith(
  status: RegistrationStatus,
  interval: number,
  ocppVersion?: string,
): Promise<{ svc: CLIChargePointService; events: CLIEvent[] }> {
  const csms = startMockCsms();
  csmsList.push(csms);
  const svc = new CLIChargePointService(
    testCpInit({ cpId: "cp-395", wsUrl: csms.url, ocppVersion }),
    null,
  );
  const events: CLIEvent[] = [];
  svc.onEvent((evt) => events.push(evt));
  services.push({ svc, events });

  await svc.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    currentTime: CURRENT_TIME,
    interval,
    status,
  });
  await until(() => events.some((evt) => evt.event === "boot_notification"));
  return { svc, events };
}

function names(events: readonly CLIEvent[]): string[] {
  return events.filter((evt) => evt.event !== "log").map((evt) => evt.event);
}

/** Exactly one boot_notification, carrying the CSMS's answer, after connected. */
function expectSingleBoot(
  events: readonly CLIEvent[],
  status: RegistrationStatus,
  interval: number,
): void {
  expect(events.filter((evt) => evt.event === "boot_notification")).toEqual([
    {
      event: "boot_notification",
      data: { status, interval, currentTime: CURRENT_TIME },
    },
  ]);
  const order = names(events);
  expect(order.indexOf("connected")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("connected")).toBeLessThan(
    order.indexOf("boot_notification"),
  );
}

const wentAvailable = (events: readonly CLIEvent[]): boolean =>
  events.some(
    (evt) => evt.event === "status_change" && evt.data.status === "Available",
  );

describe("boot_notification control-plane event (#395)", () => {
  it("Accepted: emitted once, after connected and before the status transitions it causes", async () => {
    const { events } = await bootWith("Accepted", 300);

    expectSingleBoot(events, "Accepted", 300);
    const boot = events.findIndex((evt) => evt.event === "boot_notification");
    const before = names(events.slice(0, boot));
    expect(before).not.toContain("status_change");
    expect(before).not.toContain("connector_status");
    // The boot's own effects follow it: the charge-point-level Available that
    // heartbeats and auto-start hang off, and the heartbeat at the CSMS's
    // interval — existing behaviour, untouched.
    expect(wentAvailable(events.slice(boot + 1))).toBe(true);
    expect(
      events.some(
        (evt) => evt.event === "heartbeat" && evt.data.intervalSeconds === 300,
      ),
    ).toBe(true);
  });

  it.each([
    ["Pending", 30],
    ["Rejected", 600],
    // The CSMS's 0, not the 60s retry a Rejected with interval 0 falls back to.
    ["Rejected", 0],
  ] as const)(
    "%s (interval %d): emitted with its status, and the charge point does not go Available",
    async (status, interval) => {
      const { events } = await bootWith(status, interval);

      expectSingleBoot(events, status, interval);
      expect(wentAvailable(events)).toBe(false);
    },
  );

  it("a connect on an already-open socket re-emits connected but no boot_notification", async () => {
    // `connect()` on an OPEN socket sends no BootNotification.req, yet
    // synthesizes `connected` so callers gating on it unblock. Pinned here
    // because the documented commissioning contract depends on it: that
    // `connected` is not a new boot and nothing follows it.
    const { svc, events } = await bootWith("Accepted", 300);
    const before = events.length;

    await svc.connect();
    await Bun.sleep(100);

    const after = names(events.slice(before));
    expect(after).toContain("connected");
    expect(after).not.toContain("boot_notification");
  });

  it("OCPP 2.0.1: the same event from the 2.0.1 response path", async () => {
    const { events } = await bootWith("Accepted", 120, "OCPP-2.0.1");

    expectSingleBoot(events, "Accepted", 120);
  });
});
