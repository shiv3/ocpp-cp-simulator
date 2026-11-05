import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { splitPemChain } from "../CertificateSignedHandler";
import {
  selfSignedRoot,
  withTrailingDerBytes,
} from "../../../../../domain/security/__tests__/certificateFixtures";

describe("splitPemChain", () => {
  it("splits a concatenated chain into trimmed PEM blocks", async () => {
    const leaf = await selfSignedRoot("01", "Leaf");
    const root = await selfSignedRoot("02", "Root");

    expect(splitPemChain(`${leaf.pem}\n${root.pem}\n`)).toEqual([
      leaf.pem.trim(),
      root.pem.trim(),
    ]);
  });

  it("rejects a chain whose certificate carries trailing bytes after its DER structure", async () => {
    const leaf = await selfSignedRoot("01", "Leaf");
    const root = await selfSignedRoot("02", "Root");

    expect(
      splitPemChain(`${withTrailingDerBytes(leaf.pem)}\n${root.pem}`),
    ).toBeNull();
  });
});
