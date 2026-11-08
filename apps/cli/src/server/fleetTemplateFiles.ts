import * as fs from "fs";
import { validateLayerConfig } from "@ocpp-cp-sim/core/cp/infrastructure/transport/network-sim/config";
import {
  ARRAY_MAX_ITEMS,
  fleetTemplateSchema,
  type FleetTemplate,
} from "@ocpp-cp-sim/contracts/index";

/**
 * The first member of `template` whose `networkSimulation` is not a valid
 * layer config, as a message naming it, or `undefined` when all are valid.
 *
 * The contract only knows the field as an object, and the layer validator
 * lives in core, so every entry point that accepts a template (the file
 * loader, `fleet.template.save`, `fleet.create`) runs this: an invalid layer
 * must fail before anything is stored or created, not once per charge point
 * after it was created (#445).
 */
export function fleetTemplateNetworkSimulationError(
  template: FleetTemplate,
): string | undefined {
  for (const group of template.groups) {
    for (const [line, member] of group.members.entries()) {
      if (member.networkSimulation === undefined) continue;
      const result = validateLayerConfig(member.networkSimulation);
      if (!result.ok) {
        return `group "${group.name}", member ${line + 1}: invalid networkSimulation: ${result.errors[0] ?? "invalid layer config"}`;
      }
    }
  }
  return undefined;
}

/** Most `--fleet-template` templates one daemon loads (the list result's ceiling). */
export const MAX_FLEET_TEMPLATE_FILE_TEMPLATES = ARRAY_MAX_ITEMS;

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
      const layerError = fleetTemplateNetworkSimulationError(parsed.data);
      if (layerError) {
        throw new Error(
          `--fleet-template ${file}: template "${parsed.data.id}": ${layerError}`,
        );
      }
      const previous = origin.get(parsed.data.id);
      if (previous !== undefined) {
        throw new Error(
          `--fleet-template ${file}: template id "${parsed.data.id}" is already defined by ${previous}`,
        );
      }
      if (origin.size >= MAX_FLEET_TEMPLATE_FILE_TEMPLATES) {
        throw new Error(
          `--fleet-template ${file}: at most ${MAX_FLEET_TEMPLATE_FILE_TEMPLATES} templates can be loaded from files`,
        );
      }
      origin.set(parsed.data.id, file);
      templates.push(parsed.data);
    });
  }
  return templates;
}
