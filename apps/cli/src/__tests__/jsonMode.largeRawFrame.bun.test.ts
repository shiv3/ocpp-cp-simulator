import { afterEach, describe, expect, it } from "bun:test";

import {
  startMockCsms,
  type MockCsms,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";

/**
 * A `send_raw_frame` whose CSMS reply is large (~900 KiB) must still produce
 * its result line when stdout is a pipe the reader drains slowly. Under Bun,
 * `console.*` lines and `process.stdout` writes cut each other short on a full
 * pipe, so JSON mode keeps stdout on `console` only.
 */
const MAIN = new URL("../main.ts", import.meta.url).pathname;
const ECHO_BYTES = 900_000;

let csms: MockCsms | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  child?.kill();
  await child?.exited;
  child = null;
  await csms?.stop();
  csms = null;
});

describe("json mode: large send_raw_frame result", () => {
  it("emits the whole result line through a slowly drained pipe", async () => {
    csms = startMockCsms();
    child = Bun.spawn(
      [
        process.execPath,
        MAIN,
        "--cp-id",
        "cp-large-raw",
        "--ws-url",
        csms.url,
        "--ocpp-version",
        "OCPP-1.6J",
        "--json",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const sink = child.stdin as { write(s: string): unknown; flush(): unknown };
    const send = (command: unknown) => {
      sink.write(`${JSON.stringify(command)}\n`);
      sink.flush();
    };

    const decoder = new TextDecoder();
    let buffered = "";
    let result: { ok?: boolean; data?: { reply?: unknown[] } } | null = null;
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const drain = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith('{"id":"raw"')) continue;
          result = JSON.parse(line);
        }
        // Slow reader: keeps the pipe full while the large lines go out.
        await Bun.sleep(5);
      }
    })();

    send({ id: "c", command: "connect" });
    const boot = await csms.waitForCall("BootNotification");
    csms.replyCallResult(boot.messageId, {
      currentTime: "2026-01-01T00:00:00Z",
      interval: 300,
      status: "Accepted",
    });

    const data = "a".repeat(ECHO_BYTES);
    send({
      id: "raw",
      command: "send_raw_frame",
      params: {
        frame: JSON.stringify([
          2,
          "big-1",
          "DataTransfer",
          { vendorId: "x", data },
        ]),
        waitMs: 20_000,
      },
    });
    const call = await csms.waitForCall("DataTransfer", 10_000);
    csms.replyCallResult(call.messageId, { status: "Accepted", data });

    const deadline = Date.now() + 15_000;
    while (result === null && Date.now() < deadline) await Bun.sleep(20);

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(JSON.stringify(result!.data?.reply)).toContain(data);
    child.kill();
    await drain.catch(() => {});
  }, 30_000);
});
