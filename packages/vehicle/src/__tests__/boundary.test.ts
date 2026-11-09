import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Dependency direction (#835): the vehicle domain imports nothing but itself.
// scripts/check-package-boundaries.ts enforces it for every file; this test
// keeps the rule next to the package so it travels with it on extraction.
const SRC = join(__dirname, "..");

describe("vehicle package boundary", () => {
  it("imports only relative files of its own", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const m of text.matchAll(
        /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
      )) {
        if (!m[1].startsWith("./")) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("declares no dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(SRC, "..", "package.json"), "utf8"),
    );
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });
});
