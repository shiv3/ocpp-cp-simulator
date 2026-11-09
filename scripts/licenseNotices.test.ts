import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import { packageLicense, renderNotices } from "./licenseNotices";

describe("license notices (#857)", () => {
  it("lists the bundled fonts and the CSS-only packages the JS graph never sees", () => {
    const text = renderNotices([]);
    for (const name of [
      "@fontsource/ibm-plex-sans@",
      "@fontsource/ibm-plex-mono@",
      "tailwindcss@",
      "flowbite@",
      "tailwindcss-animate@",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("License: OFL-1.1");
    expect(text).not.toContain("UNKNOWN");
  });

  it("resolves a nested copy from its own directory, not the hoisted one", () => {
    const nm = mkdtempSync(path.join(os.tmpdir(), "nm-"));
    const put = (dir: string, version: string, text: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "dep", version, license: "MIT" }),
      );
      writeFileSync(path.join(dir, "LICENSE"), text);
    };
    put(path.join(nm, "dep"), "2.0.0", "hoisted text");
    put(path.join(nm, "host", "node_modules", "dep"), "1.0.0", "nested text");
    expect(packageLicense("dep", "1.0.0", nm).text).toBe("nested text");
    expect(packageLicense("dep", "2.0.0", nm).text).toBe("hoisted text");
  });
});
