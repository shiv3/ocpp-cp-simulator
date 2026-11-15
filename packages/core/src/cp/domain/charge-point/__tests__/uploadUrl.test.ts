import { describe, expect, it } from "vitest";
import { checkUploadUrl } from "../uploadUrl";

describe("checkUploadUrl (#926)", () => {
  it.each([
    "https://csms.example/logs",
    "http://csms.example:8080/up?id=1",
    "http://93.184.216.34/x",
    "https://[2606:4700::1111]/x",
  ])("accepts %s", (url) => {
    expect(checkUploadUrl(url, false).ok).toBe(true);
  });

  it.each([
    ["ftp://csms.example/x", /scheme/],
    ["file:///etc/passwd", /scheme/],
    ["javascript:alert(1)", /scheme/],
    ["not a url", /valid/],
    ["https://u:p@csms.example/x", /credentials/],
    ["http://localhost/x", /internal/],
    ["http://LOCALHOST./x", /internal/],
    ["http://app.localhost/x", /internal/],
    ["http://printer.local/x", /internal/],
    ["http://metadata.google.internal/x", /internal/],
    ["http://127.0.0.1/x", /internal/],
    ["http://127.1.2.3/x", /internal/],
    ["http://10.0.0.5/x", /internal/],
    ["http://172.16.0.1/x", /internal/],
    ["http://172.31.255.1/x", /internal/],
    ["http://192.168.1.1/x", /internal/],
    ["http://169.254.169.254/x", /internal/],
    ["http://100.64.0.1/x", /internal/],
    ["http://0.0.0.0/x", /internal/],
    ["http://[::1]/x", /internal/],
    ["http://[fd00::1]/x", /internal/],
    ["http://[fe80::1]/x", /internal/],
    ["http://[::ffff:127.0.0.1]/x", /internal/],
    ["http://2130706433/x", /internal/], // 127.0.0.1 as one integer
    ["http://0x7f.1/x", /internal/],
  ])("refuses %s", (url, why) => {
    const v = checkUploadUrl(url, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(why);
  });

  it("does not refuse 172.15 / 172.32 (outside 172.16/12)", () => {
    expect(checkUploadUrl("http://172.15.0.1/x", false).ok).toBe(true);
    expect(checkUploadUrl("http://172.32.0.1/x", false).ok).toBe(true);
  });

  it("allows private hosts only when the operator says so; scheme and credentials stay refused", () => {
    expect(checkUploadUrl("http://127.0.0.1:9/x", true).ok).toBe(true);
    expect(checkUploadUrl("http://localhost/x", true).ok).toBe(true);
    expect(checkUploadUrl("ftp://127.0.0.1/x", true).ok).toBe(false);
    expect(checkUploadUrl("http://u:p@127.0.0.1/x", true).ok).toBe(false);
  });
});
