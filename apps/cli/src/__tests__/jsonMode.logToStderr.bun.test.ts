import { afterEach, describe, expect, it } from "bun:test";

import {
  startMockCsms,
  type MockCsms,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";

/** `--json --log-to-stderr` (#1088): stdout is pure JSON Lines, logs on stderr. */
const MAIN = new URL("../main.ts", import.meta.url).pathname;

let csms: MockCsms | null = null;

afterEach(async () => {
  await csms?.stop();
  csms = null;
});

async function run(extra: string[]): Promise<{ out: string; err: string }> {
  csms = startMockCsms();
  const child = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--cp-id",
      "cp-log-stderr",
      "--ws-url",
      csms.url,
      "--ocpp-version",
      "OCPP-1.6J",
      "--json",
      ...extra,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const sink = child.stdin as { write(s: string): unknown; flush(): unknown };
  sink.write('{"id":"1","command":"connect"}\n');
  sink.flush();
  await Bun.sleep(1200);
  sink.write('{"id":"2","command":"status"}\n');
  sink.flush();
  await Bun.sleep(300);
  child.kill();
  await child.exited;
  return {
    out: await new Response(child.stdout as ReadableStream).text(),
    err: await new Response(child.stderr as ReadableStream).text(),
  };
}

describe("json mode: --log-to-stderr", () => {
  it("keeps stdout pure JSON Lines and puts the wire lines on stderr", async () => {
    const { out, err } = await run(["--log-to-stderr"]);
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.some((l) => l.includes('"id":"2"'))).toBe(true);
    expect(err).toContain("[WebSocket] Sent:");
  });

  it("without the flag the wire lines stay on stdout (TCK contract)", async () => {
    const { out } = await run([]);
    expect(out).toContain("[WebSocket] Sent:");
  });
});
