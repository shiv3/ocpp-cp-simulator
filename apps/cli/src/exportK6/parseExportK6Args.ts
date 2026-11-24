export const EXPORT_K6_USAGE = `Usage: ocpp-cp-sim export-k6 (--scenario <file.json> | --behavior <file>...) [options]
  --scenario <file>       Scenario JSON exported from the simulator
  --behavior <file>       A behavior (TypeScript or built bundle); repeatable.
                          Alone, or together with --scenario
  -o, --out <dir>         Output directory (default: k6-loadtest)
  --chargers-per-vu <n>   Charge points one k6 virtual user drives (default: 50);
                          override at run time with CHARGERS_PER_VU
  --ocpp-version <v>      OCPP version for the generated test (default: 1.6;
                          only 1.6 is supported)
  --force                 Overwrite a non-empty output directory`;

export interface ExportK6Args {
  /** Empty when only behaviors are exported. */
  scenarioFile: string;
  behaviorFiles?: string[];
  outDir: string;
  ocppVersion: "1.6";
  chargersPerVu: number;
  force: boolean;
}

export type ExportK6ParseResult =
  { ok: true; args: ExportK6Args } | { ok: false; message: string };

export function parseExportK6Args(argv: string[]): ExportK6ParseResult {
  let scenarioFile: string | undefined;
  const behaviorFiles: string[] = [];
  let outDir = "k6-loadtest";
  let ocppVersion = "1.6";
  let chargersPerVu = 50;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "--scenario" ||
      arg === "--behavior" ||
      arg === "-o" ||
      arg === "--out" ||
      arg === "--ocpp-version" ||
      arg === "--chargers-per-vu"
    ) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          ok: false,
          message: `Error: ${arg} requires a value\n${EXPORT_K6_USAGE}`,
        };
      }
      if (arg === "--scenario") scenarioFile = next;
      else if (arg === "--behavior") behaviorFiles.push(next);
      else if (arg === "--ocpp-version") ocppVersion = next;
      else if (arg === "--chargers-per-vu") {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1) {
          return {
            ok: false,
            message: `Error: --chargers-per-vu must be an integer >= 1 (got "${next}")\n${EXPORT_K6_USAGE}`,
          };
        }
        chargersPerVu = n;
      } else outDir = next;
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

  if (scenarioFile === undefined && behaviorFiles.length === 0) {
    return {
      ok: false,
      message: `Error: --scenario <file> or --behavior <file> is required\n${EXPORT_K6_USAGE}`,
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
  return {
    ok: true,
    args: {
      scenarioFile: scenarioFile ?? "",
      ...(behaviorFiles.length > 0 ? { behaviorFiles } : {}),
      outDir,
      ocppVersion,
      chargersPerVu,
      force,
    },
  };
}
