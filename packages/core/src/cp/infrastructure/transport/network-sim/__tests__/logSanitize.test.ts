import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "../logSanitize";

describe("sanitizeForLog", () => {
  it("escapes \\n (LF) to \\\\n", () => {
    expect(sanitizeForLog("hello\nworld")).toBe("hello\\nworld");
  });

  it("escapes \\r (CR) to \\\\r", () => {
    expect(sanitizeForLog("hello\rworld")).toBe("hello\\rworld");
  });

  it("escapes control chars (0x00-0x1F except \\r and \\n) to \\\\xHH", () => {
    expect(sanitizeForLog("hello\x00world")).toBe("hello\\x00world");
    expect(sanitizeForLog("hello\x01world")).toBe("hello\\x01world");
    expect(sanitizeForLog("hello\x1fworld")).toBe("hello\\x1fworld");
  });

  it("escapes DEL (0x7F) to \\\\x7f", () => {
    expect(sanitizeForLog("hello\x7fworld")).toBe("hello\\x7fworld");
  });

  it("preserves printable strings unchanged", () => {
    const printable = "Hello World 123 !@#$%";
    expect(sanitizeForLog(printable)).toBe(printable);
  });

  it("handles empty string", () => {
    expect(sanitizeForLog("")).toBe("");
  });

  it("preserves unicode and multi-byte UTF-8", () => {
    expect(sanitizeForLog("Hello 你好 مرحبا")).toBe("Hello 你好 مرحبا");
    expect(sanitizeForLog("emoji 🚀")).toBe("emoji 🚀");
  });

  it("prevents log-forging with newline injection", () => {
    const malicious =
      "user_id\n[RULE:evil]INJECTED INFO evil_rule System hacked";
    const sanitized = sanitizeForLog(malicious);
    // The newline should be escaped, preventing a fake log entry on a new line
    expect(sanitized).toContain("user_id\\n[RULE:evil]");
    expect(sanitized).not.toContain("user_id\n");
  });

  it("handles multiple control characters in one string", () => {
    expect(sanitizeForLog("a\x00b\nc\rd")).toBe("a\\x00b\\nc\\rd");
  });

  it("escapes control chars with correct hex format", () => {
    expect(sanitizeForLog("\x00")).toBe("\\x00");
    expect(sanitizeForLog("\x09")).toBe("\\x09"); // tab
    expect(sanitizeForLog("\x1f")).toBe("\\x1f");
  });

  it("early returns unchanged for strings with no control chars", () => {
    // Early return should not allocate a new string if no control chars
    const clean = "no control chars here";
    const result = sanitizeForLog(clean);
    expect(result).toBe(clean);
  });
});
