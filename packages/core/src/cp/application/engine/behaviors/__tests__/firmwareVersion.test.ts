import { describe, expect, it } from "vitest";

import {
  FIRMWARE_VERSION_MAX_LENGTH,
  deriveFirmwareVersion,
  firmwareFileStem,
  incrementFirmwareVersion,
} from "../firmwareVersion";

describe("firmwareFileStem", () => {
  it.each([
    ["https://x/fw/cp-firmware-2.3.1.bin", "cp-firmware-2.3.1"],
    ["ftp://h/v1.4.0-rc1.tar.gz", "v1.4.0-rc1"],
    ["https://x/fw/image.BIN?token=1.2.3#frag", "image"],
    ["https://x/fw/3.0.0/", "3.0.0"],
    ["https://x/a.b/fw.img.sig", "fw"],
    ["", ""],
  ])("%s -> %s", (location, stem) => {
    expect(firmwareFileStem(location)).toBe(stem);
  });
});

describe("incrementFirmwareVersion", () => {
  it.each([
    ["1.0", "1.1"],
    ["fw-7", "fw-8"],
    ["2.0.9", "2.0.10"],
    ["fw-007", "fw-008"],
    ["99", "100"],
    ["beta", "beta.1"],
    ["1.0-rc", "1.0-rc.1"],
    ["", "1"],
  ])("%s -> %s", (current, next) => {
    expect(incrementFirmwareVersion(current)).toBe(next);
  });
});

describe("deriveFirmwareVersion", () => {
  it("takes the version token of the file name", () => {
    expect(
      deriveFirmwareVersion("https://x/fw/cp-firmware-2.3.1.bin", "1.0"),
    ).toBe("2.3.1");
    expect(deriveFirmwareVersion("https://x/v1.4.0-rc1.tar.gz", "1.0")).toBe(
      "1.4.0-rc1",
    );
    expect(deriveFirmwareVersion("https://x/fw-10.2+build.7.zip", "1")).toBe(
      "10.2+build.7",
    );
  });

  it("ignores versions in the directories and in the query", () => {
    expect(
      deriveFirmwareVersion("https://x/9.9.9/latest.bin?v=8.8", "1.0"),
    ).toBe("1.1");
  });

  it("increments the current version when the name has no version", () => {
    expect(deriveFirmwareVersion("https://x/fw/latest.bin", "1.0")).toBe("1.1");
    expect(deriveFirmwareVersion("https://x/fw/build7.bin", "2.0.9")).toBe(
      "2.0.10",
    );
    expect(deriveFirmwareVersion(undefined, "fw-7")).toBe("fw-8");
    expect(deriveFirmwareVersion(undefined, undefined)).toBe("1");
  });

  it("keeps a token equal to the current version", () => {
    expect(deriveFirmwareVersion("https://x/fw-1.0.0.bin", "1.0.0")).toBe(
      "1.0.0",
    );
  });

  it("truncates to the BootNotification limit of 50 characters", () => {
    const long = `1.0-${"a".repeat(80)}`;
    expect(deriveFirmwareVersion(`https://x/${long}.bin`, "1")).toHaveLength(
      FIRMWARE_VERSION_MAX_LENGTH,
    );
    expect(deriveFirmwareVersion(undefined, "x".repeat(60))).toHaveLength(50);
  });
});
