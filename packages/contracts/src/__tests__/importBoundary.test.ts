// packages/contracts/src/__tests__/importBoundary.test.ts
//
// @ocpp-cp-simulator/contracts is the contract of the control plane (#578). The
// charge-point core and both apps depend on it, never the reverse, so no
// non-test file here may import another workspace package, reach outside its
// own src/ with a relative path, or use the apps/web `@/` alias (at runtime
// or type-only) beyond the allow-list below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const protocolDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Workspace packages (`@ocpp-cp-simulator/<name>`) that this package may import
 * besides itself. Each entry is a dependency in its package.json. Empty
 * today: the protocol depends on third-party packages (zod) only. The core
 * must never appear here.
 */
const ALLOWED_WORKSPACE_PACKAGES: readonly string[] = [];

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : listSources(full);
    }
    return name.endsWith(".ts") && !/\.(test|bun\.test)\.ts$/.test(name)
      ? [full]
      : [];
  });
}

/** Every module specifier: import / export ... from, side-effect and dynamic. */
function specifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/**
 * What a repo-internal specifier points at: a path (relative specifier), the
 * `@/` alias, or a workspace package name. Third-party and node: packages
 * return null.
 */
function classify(
  from: string,
  specifier: string,
):
  | { kind: "path"; path: string }
  | { kind: "alias" }
  | { kind: "package"; name: string }
  | null {
  if (specifier.startsWith("@/")) return { kind: "alias" };
  if (specifier.startsWith("."))
    return { kind: "path", path: resolve(dirname(from), specifier) };
  const ws = /^(@ocpp-cp-simulator\/[^/]+)/.exec(specifier);
  return ws ? { kind: "package", name: ws[1]! } : null;
}

const isInside = (path: string, dir: string) =>
  path === dir || path.startsWith(dir + sep);

describe("packages/contracts/src import boundary", () => {
  const files = listSources(protocolDir);

  it("scans the protocol sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never lists the core, the client or an app as an allowed dependency", () => {
    expect(
      ALLOWED_WORKSPACE_PACKAGES.filter((n) =>
        /\/(core|client|cli|web)$/.test(n),
      ),
    ).toEqual([]);
  });

  it("imports nothing from the repository outside packages/contracts/src except the allow-list", () => {
    const own = protocolDir.replace(/[\\/]$/, "");
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const target = classify(file, specifier);
        if (target === null) continue;
        if (target.kind === "path" && isInside(target.path, own)) continue;
        if (
          target.kind === "package" &&
          (target.name === "@ocpp-cp-simulator/contracts" ||
            ALLOWED_WORKSPACE_PACKAGES.includes(target.name))
        )
          continue;
        violations.push(
          `${relative(own, file)} imports "${specifier}"${
            target.kind === "path" ? ` (${relative(own, target.path)})` : ""
          }`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("extracts the import forms it must catch", () => {
    const sample = [
      'import { a } from "../cp/a";',
      'import type { B } from "@/cp/b";',
      'export { c } from "../cp/c";',
      'export type { D } from "../cp/d";',
      'export * from "../cp/e";',
      'import "../cp/f";',
      'const g = await import("../cp/g");',
      'import {\n  h,\n  type I,\n} from "../cp/h";',
      '// import { x } from "../cp/commented";',
    ].join("\n");
    expect(specifiers(sample).sort()).toEqual(
      [
        "../cp/a",
        "../cp/c",
        "../cp/d",
        "../cp/e",
        "../cp/f",
        "../cp/g",
        "../cp/h",
        "@/cp/b",
      ].sort(),
    );
  });
});
