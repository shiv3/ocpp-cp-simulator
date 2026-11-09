import { afterEach, describe, expect, it } from "bun:test";
import {
  type JsonModeSession,
  startJsonMode,
  startStubCsms,
  type StubCsms,
} from "./tckHarness";

// GOLDEN TEST FOR AN EXTERNAL CONSUMER (#346 item 1).
//
// open-ocpp-tck reads the OCPP frames a charge point exchanged from the
// simulator's stdout, one line per frame:
//
//   [<ISO-8601 UTC, ms>] [INFO] [WebSocket] Sent: <raw frame>
//   [<ISO-8601 UTC, ms>] [INFO] [WebSocket] Received: <raw frame>
//
// (its tck/ocpp.ts parses exactly this, and the parser also exists in
// packages/core/src/cp/application/verification/ocpp.ts). The parsers have
// their own tests; nothing else pins the *producer*, which is what this file
// does: the real CLI, a real WebSocket, the lines as they reach stdout in the
// default `--log-format plain`. If it fails, the TCK stops seeing frames; do
// not edit the pattern to match, keep the line format (or add the new format
// beside it and announce it in docs/entities/cli.md).

const LINE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[INFO\] \[WebSocket\] (Sent|Received): (\[.*\])$/;

let csms: StubCsms | undefined;
let cp: JsonModeSession | undefined;

afterEach(async () => {
  cp?.kill();
  await csms?.stop();
  cp = undefined;
  csms = undefined;
});

function wireLines(
  stdout: readonly string[],
): Array<{ direction: string; frame: string; time: string }> {
  return stdout.flatMap((line) => {
    const m = LINE.exec(line);
    return m ? [{ time: m[1], direction: m[2], frame: m[3] }] : [];
  });
}

describe("TCK contract: Sent: / Received: lines on stdout (#346)", () => {
  it("prints every frame, in both directions, verbatim, in the TCK's format", async () => {
    csms = startStubCsms();
    cp = startJsonMode(csms.url);
    await cp.request("connect");
    await cp.waitForLine((l) => l.includes('"event":"boot_notification"'));
    await cp.request("heartbeat");
    const heartbeat = await cp.waitForLine(
      (l) => l.includes("Sent:") && l.includes('"Heartbeat"'),
    );
    const heartbeatId = (
      JSON.parse(/Sent: (\[.*\])$/.exec(heartbeat)![1]) as unknown[]
    )[1] as string;
    await cp.waitForLine(
      (l) => l.includes("Received:") && l.includes(heartbeatId),
    );
    expect(await cp.end()).toBe(0);

    const lines = wireLines(cp.stdout);
    const sent = lines.filter((l) => l.direction === "Sent");
    const received = lines.filter((l) => l.direction === "Received");

    // The CSMS may still be reading the last frame when the CLI has exited.
    for (let i = 0; i < 100 && csms.frames.length < sent.length; i++)
      await Bun.sleep(50);

    // `Sent:` carries the exact text the CSMS received, in order.
    expect(sent.map((l) => l.frame)).toEqual(csms.frames);

    // The first frame is the BootNotification CALL, 1.6 payload.
    const boot = JSON.parse(sent[0].frame) as unknown[];
    expect(boot[0]).toBe(2);
    expect(boot[2]).toBe("BootNotification");
    expect(boot[3]).toMatchObject({
      chargePointVendor: "CLI-Vendor",
      chargePointModel: "CLI-Model",
    });

    // `Received:` is the CALLRESULT for it, with the same message id.
    const bootResult = received
      .map((l) => JSON.parse(l.frame) as unknown[])
      .find((f) => f[0] === 3 && f[1] === boot[1]);
    expect(bootResult?.[2]).toMatchObject({
      status: "Accepted",
      interval: 300,
    });

    // Heartbeat CALL and its CALLRESULT are there as well.
    expect(
      received.some((l) => l.frame.startsWith(`[3,"${heartbeatId}",`)),
    ).toBe(true);

    // Timestamps are real, non-decreasing UTC times.
    const times = lines.map((l) => Date.parse(l.time));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }, 30_000);

  it("keeps the wire lines out of the JSON Lines protocol lines", async () => {
    csms = startStubCsms();
    cp = startJsonMode(csms.url);
    await cp.request("connect");
    await cp.end();
    // Every stdout line is either a wire/log line, or a JSON object the TCK
    // reads as a response (`id`) or event (`event`). Nothing in between.
    for (const line of cp.stdout) {
      if (line.startsWith("[")) {
        expect(line, line).toMatch(
          /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[[A-Z]+\] \[/,
        );
      } else {
        const obj = JSON.parse(line) as Record<string, unknown>;
        expect("id" in obj || "event" in obj, line).toBe(true);
      }
    }
  }, 30_000);
});
