import * as fs from "fs";
import {
  BLUEPRINT_SCHEMA_VERSION,
  blueprintSchema,
  type Blueprint,
} from "@ocpp-cp-simulator/contracts/index";
import {
  isBuiltInBlueprint,
  MAX_STORED_BLUEPRINTS,
} from "@ocpp-cp-simulator/core/utils/blueprints/index";

/**
 * Most `--blueprint` blueprints one daemon loads. They share the
 * `blueprint.list` result cap with the built-ins and the stored ones, and
 * `blueprint.save` counts them against the same ceiling.
 */
export const MAX_BLUEPRINT_FILE_BLUEPRINTS = MAX_STORED_BLUEPRINTS;

/**
 * Read `--blueprint` files (#331): each holds one blueprint or an array of
 * them, in exactly the shape `blueprint.save` takes — the same
 * `blueprintSchema`, so a file and the state database cannot drift. This is
 * how a documented charger description (for example the samples under
 * `docs/examples/blueprints/`) reaches a daemon without becoming part of the
 * built-in catalogue.
 *
 * Throws one `Error` naming the file (and the offending path inside it) for an
 * unreadable file, invalid JSON, a schema violation (including a
 * `schemaVersion` this build does not read), a built-in id, or an id that two
 * files both define; the caller turns that into exit code 1. Nothing is
 * skipped: a blueprint file that is silently half-loaded would show up as a
 * `not_found` from `cp.create_many` long after the daemon started.
 */
export function loadBlueprintFiles(
  files: readonly string[],
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): Blueprint[] {
  const blueprints: Blueprint[] = [];
  const origin = new Map<string, string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFile(file));
    } catch (err) {
      throw new Error(
        `--blueprint ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const entries = Array.isArray(raw) ? raw : [raw];
    entries.forEach((entry, i) => {
      const version =
        typeof entry === "object" && entry !== null
          ? (entry as { schemaVersion?: unknown }).schemaVersion
          : undefined;
      if (typeof version === "number" && version !== BLUEPRINT_SCHEMA_VERSION) {
        // Said plainly rather than as a literal mismatch: the usual cause is a
        // file written for a newer build, and the fix is to upgrade.
        const at = Array.isArray(raw) ? `${i}.` : "";
        throw new Error(
          `--blueprint ${file}: ${at}schemaVersion ${version} is not supported by this build (supports ${BLUEPRINT_SCHEMA_VERSION})`,
        );
      }
      const parsed = blueprintSchema.safeParse(entry);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const at = [Array.isArray(raw) ? i : null, ...(issue?.path ?? [])]
          .filter((p) => p !== null)
          .join(".");
        throw new Error(
          `--blueprint ${file}: ${at ? `${at}: ` : ""}${issue?.message ?? "invalid blueprint"}`,
        );
      }
      const id = parsed.data.id;
      if (isBuiltInBlueprint(id)) {
        // Refused for the same reason `blueprint.save` refuses it: two
        // definitions behind one id would make `blueprint.list` ambiguous.
        throw new Error(
          `--blueprint ${file}: "${id}" is a built-in blueprint id; choose another id`,
        );
      }
      const previous = origin.get(id);
      if (previous !== undefined) {
        throw new Error(
          `--blueprint ${file}: blueprint id "${id}" is already defined by ${previous}`,
        );
      }
      if (origin.size >= MAX_BLUEPRINT_FILE_BLUEPRINTS) {
        throw new Error(
          `--blueprint ${file}: at most ${MAX_BLUEPRINT_FILE_BLUEPRINTS} blueprints can be loaded from files`,
        );
      }
      origin.set(id, file);
      blueprints.push(parsed.data);
    });
  }
  return blueprints;
}
