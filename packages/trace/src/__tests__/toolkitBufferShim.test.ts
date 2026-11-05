import { afterEach, describe, expect, it } from "vitest";

import { ensureToolkitBufferShim } from "../toolkitBufferShim";

type BufferHolder = { Buffer?: { byteLength(input: string): number } };

const holder = globalThis as BufferHolder;
const realBuffer = holder.Buffer;

describe("ensureToolkitBufferShim", () => {
  afterEach(() => {
    holder.Buffer = realBuffer;
  });

  it("leaves a present Buffer global untouched", () => {
    expect(realBuffer, "test must run where Buffer exists").toBeDefined();
    ensureToolkitBufferShim();
    expect(holder.Buffer).toBe(realBuffer);
  });

  it("installs a byteLength stand-in when Buffer is absent (browser)", () => {
    delete holder.Buffer;
    ensureToolkitBufferShim();
    expect(holder.Buffer).toBeDefined();
    expect(holder.Buffer).not.toBe(realBuffer);

    // UTF-8 byte lengths, not UTF-16 code-unit counts: ASCII, a 3-byte
    // kana, and a 4-byte surrogate-pair emoji — each checked against the
    // real Buffer's answer.
    for (const s of ["", "abc", "あ", "🔌", 'Sent: [2,"1","Heartbeat",{}]']) {
      expect(holder.Buffer!.byteLength(s)).toBe(realBuffer!.byteLength(s));
    }
  });
});
