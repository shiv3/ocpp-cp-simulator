import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runHelp(): string {
  const result = spawnSync("bun", ["src/cli/main.ts", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stderr;
}

/**
 * Every flag the argument parser accepts must be documented.
 *
 * `--cp-count` / `--cp-id-pattern` (#295) and `--metrics` /
 * `--metrics-no-auth` (#298) appeared only in the terse "Server modes"
 * summary; `--header` and `--ws-subprotocol` appeared nowhere in `--help` at
 * all, only in `docs/entities/cli.md`. Each was found by reading the parser
 * against the help text by hand, which is how three of them survived several
 * releases — so this asserts the property instead of a list of known gaps.
 */
const MODE_SELECTORS = new Set([
  "--daemon",
  "--events",
  "--help",
  "--json",
  "--send",
  "--stop",
]);

function parsedFlags(): string[] {
  const src = readFileSync(join(repoRoot, "src/cli/main.ts"), "utf8");
  return [...new Set(src.match(/case "--[a-z0-9-]+"/g) ?? [])].map((m) =>
    m.slice(6, -1),
  );
}

describe("--help documents every flag the parser accepts (#295, #298)", () => {
  it("gives every non-mode flag its own Options: entry", () => {
    const help = runHelp();
    const optionsSection = help.slice(help.indexOf("\nOptions:"));
    const flags = parsedFlags();
    // Guard the guard: a parser refactor that stopped matching would make
    // every assertion below vacuously true.
    expect(flags.length).toBeGreaterThan(40);

    const undocumented = flags
      .filter((flag) => !MODE_SELECTORS.has(flag))
      // A bare substring match would let `--metrics` match inside
      // `--metrics-no-auth`'s entry — anchor on the flag starting its own
      // line, the way every other Options: entry does.
      .filter(
        (flag) =>
          !new RegExp(
            `^  ${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
            "m",
          ).test(optionsSection),
      );
    expect(undocumented).toEqual([]);
  });

  it("documents each mode selector in a mode summary instead", () => {
    // The six mode selectors are deliberately not in Options: — they choose
    // what the process does, and live in the "Server modes" / "Client modes"
    // summaries. That is a real distinction, not an oversight, so it is
    // asserted rather than merely excluded above.
    const help = runHelp();
    const summary = help.slice(0, help.indexOf("\nOptions:"));
    for (const flag of MODE_SELECTORS) {
      if (flag === "--help") continue;
      expect(summary).toContain(flag);
    }
  });

  it("still lists the #295/#298 flags in the Server modes summary", () => {
    const help = runHelp();
    const summarySection = help.slice(
      help.indexOf("Server modes"),
      help.indexOf("Client modes"),
    );
    for (const flag of [
      "--cp-count",
      "--cp-id-pattern",
      "--metrics",
      "--metrics-no-auth",
    ]) {
      expect(summarySection).toContain(flag);
    }
  });
});
