import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import {
  bundledPackages,
  packageLicense,
  renderNotices,
} from "./licenseNotices";

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

describe("CLI bundle notices (#870)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-notices-"));
  const put = (dir: string, pkg: object, license?: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    if (license) writeFileSync(path.join(dir, "LICENSE"), license);
  };
  put(
    path.join(root, "node_modules", "ws"),
    { name: "ws", version: "8.0.0", license: "MIT" },
    "ws license text",
  );
  put(path.join(root, "node_modules", "@scope", "pkg"), {
    name: "@scope/pkg",
    version: "2.0.0",
    license: "ISC",
  });
  put(path.join(root, "node_modules", "ws", "node_modules", "inner"), {
    name: "inner",
    version: "1.0.0",
    license: "MIT",
  });
  put(path.join(root, "node_modules", "@ocpp-cp-simulator", "core"), {
    name: "@ocpp-cp-simulator/core",
    version: "0.0.0",
  });

  const inputs = [
    "apps/cli/src/main.ts",
    "node_modules/ws/index.js",
    "node_modules/ws/lib/x.js",
    "node_modules/@scope/pkg/dist/y.js",
    "node_modules/ws/node_modules/inner/z.js",
    "node_modules/@ocpp-cp-simulator/core/src/a.ts",
    "node_modules/gone/index.js",
  ];

  it("finds each inlined package once, nested copies by their own name", () => {
    const names = bundledPackages(inputs, root)
      .map((p) => `${p.name}@${p.version}`)
      .sort();
    expect(names).toEqual(["@scope/pkg@2.0.0", "inner@1.0.0", "ws@8.0.0"]);
  });

  it("leaves out the workspace's own packages and ones that are not installed", () => {
    const names = bundledPackages(inputs, root).map((p) => p.name);
    expect(names).not.toContain("@ocpp-cp-simulator/core");
    expect(names).not.toContain("gone");
  });

  it("reads the legacy `licenses` array and falls back for a package that ships no license", () => {
    put(
      path.join(root, "node_modules", "legacy"),
      { name: "legacy", version: "1.0.0", licenses: [{ type: "MIT" }] },
      "legacy text",
    );
    put(path.join(root, "node_modules", "mcp-lite"), {
      name: "mcp-lite",
      version: "0.10.0",
    });
    const got = bundledPackages(
      ["node_modules/legacy/a.js", "node_modules/mcp-lite/b.js"],
      root,
    );
    const by = (n: string) => got.find((p) => p.name === n);
    expect(by("legacy")?.license).toBe("MIT");
    expect(by("mcp-lite")?.license).toBe("MIT");
    const text = renderNotices(got, path.join(root, "node_modules"), {
      assetPackages: [],
    });
    expect(text).toContain("Copyright (c) 2025 Fiberplane");
    expect(text).not.toContain("UNKNOWN");
  });

  it("renders the CLI title and no web-console fonts", () => {
    const text = renderNotices(
      bundledPackages(inputs, root),
      path.join(root, "node_modules"),
      {
        title: "Third-party software bundled in the CLI (dist-cli/main.js).",
        assetPackages: [],
      },
    );
    expect(text).toContain("bundled in the CLI");
    expect(text).toContain("ws license text");
    expect(text).not.toContain("ibm-plex");
  });
});
