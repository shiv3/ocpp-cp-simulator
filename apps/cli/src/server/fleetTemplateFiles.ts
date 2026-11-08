import * as fs from "fs";
import {
  fleetTemplateSchema,
  type FleetTemplate,
} from "@ocpp-cp-sim/contracts/index";

/**
 * Read `--fleet-template` files (#445, D09): each holds one fleet template or
 * an array of them, in exactly the shape `fleet.template.save` takes — the
 * same `fleetTemplateSchema`, so a file and the state database cannot drift.
 *
 * Throws one `Error` naming the file (and the offending path inside it) for an
 * unreadable file, invalid JSON, a schema violation, or an id that two files
 * both define; the caller turns that into exit code 1. Nothing is skipped: a
 * template file that is silently half-loaded would show up as a `not_found`
 * long after the daemon started.
 */
export function loadFleetTemplateFiles(
  files: readonly string[],
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): FleetTemplate[] {
  const templates: FleetTemplate[] = [];
  const origin = new Map<string, string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFile(file));
    } catch (err) {
      throw new Error(
        `--fleet-template ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const entries = Array.isArray(raw) ? raw : [raw];
    entries.forEach((entry, i) => {
      const parsed = fleetTemplateSchema.safeParse(entry);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const at = [Array.isArray(raw) ? i : null, ...(issue?.path ?? [])]
          .filter((p) => p !== null)
          .join(".");
        throw new Error(
          `--fleet-template ${file}: ${at ? `${at}: ` : ""}${issue?.message ?? "invalid fleet template"}`,
        );
      }
      const previous = origin.get(parsed.data.id);
      if (previous !== undefined) {
        throw new Error(
          `--fleet-template ${file}: template id "${parsed.data.id}" is already defined by ${previous}`,
        );
      }
      origin.set(parsed.data.id, file);
      templates.push(parsed.data);
    });
  }
  return templates;
}
