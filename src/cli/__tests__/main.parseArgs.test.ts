import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runParseArgs(args: string[]) {
  const script = [
    'import { parseArgs } from "./src/cli/main.ts";',
    `const options = parseArgs(["bun", "src/cli/main.ts", ...${JSON.stringify(
      args,
    )}]);`,
    "console.log(JSON.stringify({ ocppVersion: options.ocppVersion ?? null }));",
  ].join("\n");

  return spawnSync("bun", ["--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("parseArgs --ocpp-version", () => {
  it("accepts OCPP-2.0.1", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-2.0.1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ocppVersion: "OCPP-2.0.1",
    });
  });

  it("leaves ocppVersion undefined when omitted", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ocppVersion: null });
  });

  it("rejects unsupported versions", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-1.6",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: --ocpp-version must be one of OCPP-1.6J, OCPP-2.0.1, OCPP-2.1",
    );
  });
});
