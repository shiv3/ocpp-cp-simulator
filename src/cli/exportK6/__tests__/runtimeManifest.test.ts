// src/cli/exportK6/__tests__/runtimeManifest.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { K6_ONLY_FILES, RUNTIME_FILES } from "../runtimeManifest";
import { RUNTIME_SOURCES } from "../runtimeSources";

const runtimeDir = fileURLToPath(new URL("../runtime", import.meta.url));

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? listFiles(full, `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

describe("runtime manifest", () => {
  it("matches the runtime directory exactly", () => {
    expect([...RUNTIME_FILES].sort()).toEqual(listFiles(runtimeDir).sort());
  });

  it("keeps k6 imports confined to the k6-only files", () => {
    for (const file of RUNTIME_FILES) {
      const source = readFileSync(join(runtimeDir, file), "utf8");
      const importsK6 = /from\s+["']k6/.test(source);
      expect(
        importsK6,
        `${file} ${K6_ONLY_FILES.includes(file) ? "may" : "must not"} import k6/*`,
      ).toBe(K6_ONLY_FILES.includes(file));
    }
  });

  // runtimeSources.ts is generated (`bun run gen:k6-runtime`) and committed:
  // the bundle and the sidecar carry it instead of the runtime/ directory, so
  // a runtime change without regeneration must fail here, not in an export.
  it("embeds every runtime file as it is on disk (bun run gen:k6-runtime)", () => {
    expect(Object.keys(RUNTIME_SOURCES).sort()).toEqual(
      [...RUNTIME_FILES].sort(),
    );
    for (const file of RUNTIME_FILES) {
      expect(RUNTIME_SOURCES[file], file).toBe(
        readFileSync(join(runtimeDir, file), "utf8"),
      );
    }
  });

  it("keeps the runtime free of repo and node imports", () => {
    for (const file of RUNTIME_FILES) {
      const source = readFileSync(join(runtimeDir, file), "utf8");
      expect(/from\s+["'](node:|bun|@\/|\.\.\/\.\.)/.test(source), file).toBe(
        false,
      );
    }
  });
});
