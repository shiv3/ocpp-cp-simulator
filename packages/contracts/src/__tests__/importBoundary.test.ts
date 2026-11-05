// packages/contracts/src/__tests__/importBoundary.test.ts
//
// `packages/contracts/src` is the contract of the control plane (#578). It is to become
// its own package that the charge-point core depends on, never the reverse, so
// no non-test file here may import from `packages/core/src/cp` (or any other part of the
// repository that is not on the allow-list below) — at runtime or type-only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const protocolDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = resolve(protocolDir, "..");

/**
 * Repository directories (relative to `src/`) that `packages/contracts/src` may import
 * from besides itself. Each entry is a dependency the future `contracts`
 * package will have. Empty today: the protocol depends on third-party packages
 * (zod) only. `cp` must never appear here.
 */
const ALLOWED_REPO_DIRECTORIES: readonly string[] = [];

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

/** The path under `src/` a repo-internal specifier points at, else null. */
function resolveInRepo(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return resolve(srcDir, specifier.slice(2));
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  return null; // a third-party or node: package
}

const isInside = (path: string, dir: string) =>
  path === dir || path.startsWith(dir + sep);

describe("packages/contracts/src import boundary", () => {
  const files = listSources(protocolDir);

  it("scans the protocol sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never lists packages/core/src/cp as an allowed dependency", () => {
    expect(ALLOWED_REPO_DIRECTORIES.some((d) => /^cp(\/|$)/.test(d))).toBe(
      false,
    );
  });

  it("imports nothing from the repository outside packages/contracts/src except the allow-list", () => {
    const allowed = ALLOWED_REPO_DIRECTORIES.map((d) => resolve(srcDir, d));
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const target = resolveInRepo(file, specifier);
        if (target === null) continue;
        if (isInside(target, protocolDir.replace(/[\\/]$/, ""))) continue;
        if (allowed.some((dir) => isInside(target, dir))) continue;
        violations.push(
          `${relative(srcDir, file)} imports "${specifier}" (src/${relative(srcDir, target)})`,
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
