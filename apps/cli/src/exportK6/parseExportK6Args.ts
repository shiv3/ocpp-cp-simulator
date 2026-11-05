export const EXPORT_K6_USAGE = `Usage: ocpp-cp-sim export-k6 --scenario <file.json> [options]
  --scenario <file>       Scenario JSON exported from the simulator (required)
  -o, --out <dir>         Output directory (default: k6-loadtest)
  --ocpp-version <v>      OCPP version for the generated test (default: 1.6)
  --force                 Overwrite a non-empty output directory`;

export interface ExportK6Args {
  scenarioFile: string;
  outDir: string;
  ocppVersion: "1.6";
  force: boolean;
}

export type ExportK6ParseResult =
  { ok: true; args: ExportK6Args } | { ok: false; message: string };

export function parseExportK6Args(argv: string[]): ExportK6ParseResult {
  let scenarioFile: string | undefined;
  let outDir = "k6-loadtest";
  let ocppVersion = "1.6";
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "--scenario" ||
      arg === "-o" ||
      arg === "--out" ||
      arg === "--ocpp-version"
    ) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          ok: false,
          message: `Error: ${arg} requires a value\n${EXPORT_K6_USAGE}`,
        };
      }
      if (arg === "--scenario") scenarioFile = next;
      else if (arg === "--ocpp-version") ocppVersion = next;
      else outDir = next;
      i++;
    } else if (arg === "--force") {
      force = true;
    } else {
      return {
        ok: false,
        message: `Unknown option: ${arg}\n${EXPORT_K6_USAGE}`,
      };
    }
  }

  if (scenarioFile === undefined) {
    return {
      ok: false,
      message: `Error: --scenario <file> is required\n${EXPORT_K6_USAGE}`,
    };
  }
  if (ocppVersion !== "1.6") {
    return {
      ok: false,
      message:
        `Error: --ocpp-version ${ocppVersion} is not supported yet (only 1.6; ` +
        `2.0.1/2.1 are planned)\n${EXPORT_K6_USAGE}`,
    };
  }
  return { ok: true, args: { scenarioFile, outDir, ocppVersion, force } };
}
