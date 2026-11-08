// Negative paths against the gocpp CSMS fixture (#623): the fixture's
// behavior is switched per test over POST /behavior (BootNotification answer
// sequence, authorization mode, offline) and CSMS commands run in sequence.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ChargePoint } from "../packages/core/src/cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../packages/core/src/cp/domain/types/OcppTypes";
import {
  startCsms,
  stopAllCsms,
  type CsmsHandle,
  type SequenceRun,
} from "./support/gocppCsms";

const WAIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

const VERSIONS = ["OCPP-1.6J", "OCPP-2.0.1"] as const;
type SimVersion = (typeof VERSIONS)[number];

const csms = new Map<SimVersion, CsmsHandle>();

beforeAll(async () => {
  for (const version of VERSIONS) csms.set(version, await startCsms(version));
});

afterEach(async () => {
  for (const handle of csms.values()) {
    await handle.stopSequences();
    await handle.resetBehavior();
  }
});

afterAll(async () => {
  await stopAllCsms();
});

function makeChargePoint(version: SimVersion, cpId: string): ChargePoint {
  const cp = new ChargePoint(
    cpId,
    DefaultBootNotification,
    1,
    csms.get(version)!.ocppUrl,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  return cp;
}

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function bootStatuses(cp: ChargePoint): string[] {
  const seen: string[] = [];
  cp.events.on("bootNotificationResult", (r) => seen.push(r.status));
  return seen;
}

function bootsRecorded(handle: CsmsHandle, cpId: string): number {
  return handle.frames
    .byCp(cpId)
    .filter((frame) => frame.action === "BootNotification").length;
}

for (const version of VERSIONS) {
  test(
    `${version}: Pending, Pending, Accepted - the station stays quiet until the third answer`,
    async () => {
      const handle = csms.get(version)!;
      const cpId = `beh-boot-${version}`;
      await handle.setBehavior({ boot: ["Pending", "Pending", "Accepted"] });
      const cp = makeChargePoint(version, cpId);
      const seen = bootStatuses(cp);

      try {
        await cp.connect();
        await waitUntil(() => seen.length === 1, "first boot answer");
        expect(seen).toEqual(["Pending"]);

        // Pending: only CSMS-initiated traffic (1.6 §4.2, 2.0.1 B02). The
        // station asks again; it does not send anything else meanwhile.
        cp.boot();
        await waitUntil(() => seen.length === 2, "second boot answer");
        expect(seen).toEqual(["Pending", "Pending"]);
        expect(
          handle.frames
            .byCp(cpId)
            .filter((frame) => frame.action === "StatusNotification"),
        ).toHaveLength(0);

        cp.boot();
        await waitUntil(() => seen.length === 3, "third boot answer");
        expect(seen).toEqual(["Pending", "Pending", "Accepted"]);
        expect(bootsRecorded(handle, cpId)).toBe(3);
        await waitUntil(
          () =>
            handle.frames
              .byCp(cpId)
              .some((frame) => frame.action === "StatusNotification"),
          "StatusNotification after Accepted",
        );
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    `${version}: whitelist and blacklist modes reject the tag the CSMS does not allow`,
    async () => {
      const handle = csms.get(version)!;
      const cpId = `beh-auth-${version}`;
      const cp = makeChargePoint(version, cpId);

      try {
        await cp.connect();
        await waitUntil(() => cp.isOnline(), "connection");
        await waitUntil(
          () => bootsRecorded(handle, cpId) > 0,
          "BootNotification",
        );

        await handle.setBehavior({ mode: "whitelist", idTags: ["GOOD"] });
        expect(await cp.authorizeAndWait("GOOD")).toBe("Accepted");
        expect(await cp.authorizeAndWait("STRANGER")).not.toBe("Accepted");

        await handle.setBehavior({ mode: "blacklist", idTags: ["BAD"] });
        expect(await cp.authorizeAndWait("BAD")).toBe("Blocked");
        expect(await cp.authorizeAndWait("GOOD")).toBe("Accepted");
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    `${version}: rate-limit mode blocks a tag that asks too often`,
    async () => {
      const handle = csms.get(version)!;
      const cpId = `beh-rate-${version}`;
      const cp = makeChargePoint(version, cpId);

      try {
        await cp.connect();
        await waitUntil(
          () => bootsRecorded(handle, cpId) > 0,
          "BootNotification",
        );
        await handle.setBehavior({
          mode: "rate-limit",
          rateMax: 1,
          rateWindowMs: 60_000,
        });
        expect(await cp.authorizeAndWait("BUSY")).toBe("Accepted");
        expect(await cp.authorizeAndWait("BUSY")).toBe("Blocked");
        expect(await cp.authorizeAndWait("OTHER")).toBe("Accepted");
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    `${version}: offline mode drops the connection and refuses the reconnect until the CSMS is back`,
    async () => {
      const handle = csms.get(version)!;
      const cpId = `beh-offline-${version}`;
      const cp = makeChargePoint(version, cpId);

      try {
        await cp.connect();
        await waitUntil(() => cp.isOnline(), "connection");
        const boots = bootsRecorded(handle, cpId);

        await handle.setBehavior({ mode: "offline" });
        await waitUntil(() => !cp.isOnline(), "connection to drop");
        // The CSMS has no connection for it any more.
        const gone = await handle.command({
          cpId,
          action: version === "OCPP-1.6J" ? "Reset" : "RequestStopTransaction",
        });
        expect(gone.ok).toBe(false);

        await handle.setBehavior({ mode: "accept-all" });
        await waitUntil(
          () => cp.isOnline() && bootsRecorded(handle, cpId) > boots,
          "reconnect and a new BootNotification",
          20_000,
        );
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );
}

test(
  "a command sequence reaches the station in order, after its delays",
  async () => {
    const version = "OCPP-1.6J";
    const handle = csms.get(version)!;
    const cpId = "beh-sequence";
    const cp = makeChargePoint(version, cpId);

    try {
      await cp.connect();
      await waitUntil(
        () => bootsRecorded(handle, cpId) > 0,
        "BootNotification",
      );
      const startedAt = Date.now();
      await handle.startSequence({
        steps: [
          {
            command: {
              cpId,
              action: "ReserveNow",
              connectorId: 1,
              expiryDate: new Date(Date.now() + 3_600_000).toISOString(),
              idTag: "SEQ",
              reservationId: 7,
            },
          },
          {
            delayMs: 400,
            command: { cpId, action: "CancelReservation", reservationId: 7 },
          },
        ],
      });

      let results: SequenceRun["results"] = [];
      await waitUntil(async () => {
        results = (await handle.sequences())[0]?.results ?? [];
        return results.length === 2;
      }, "both steps to finish");

      expect(results.map((r) => r.step)).toEqual([0, 1]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);
