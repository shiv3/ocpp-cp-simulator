import * as fs from "fs";

/**
 * How many idTags one pool may hold. Bounded because the list is persisted as
 * JSON on the charge point row and drawn from on a hot path; a tag file is an
 * operator-supplied input like any other.
 */
export const MAX_ID_TAGS = 1_000;

/** Matches the inline form's `STR_256`, so `file` is not a way around it. */
export const MAX_ID_TAG_LENGTH = 256;

/**
 * Read an idTag file: a JSON array of non-empty strings.
 *
 * Lives in its own module rather than beside `parseCreateBody` because two
 * callers need the *identical* rules: the create path, where a bad file must
 * fail the create, and the `--watch` reload path (#314), where a bad file must
 * be rejected and leave the running pool untouched. A reload that validated
 * more loosely than creation would be a way to install a pool that
 * `cp.create` would have refused.
 */
export function readIdTagsFile(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `idTagPool.file "${filePath}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return parseIdTagsFile(filePath, raw);
}

/** The validation half of {@link readIdTagsFile}, for a caller that already
 *  has the file's text in hand (the watcher reads once and compares). */
export function parseIdTagsFile(filePath: string, raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`idTagPool.file "${filePath}" is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((t) => typeof t === "string" && t.length > 0)
  ) {
    throw new Error(
      `idTagPool.file "${filePath}" must hold a JSON array of non-empty strings`,
    );
  }
  // The same per-tag bound the inline form gets from `STR_256`. Without it the
  // file was a way around the identifier cap, persisting and presenting
  // arbitrarily long tags.
  const tooLong = parsed.find((t) => t.length > MAX_ID_TAG_LENGTH);
  if (tooLong !== undefined) {
    throw new Error(
      `idTagPool.file "${filePath}" holds a tag longer than ${MAX_ID_TAG_LENGTH} characters`,
    );
  }
  if (parsed.length > MAX_ID_TAGS) {
    throw new Error(
      `idTagPool.file "${filePath}" holds more than ${MAX_ID_TAGS} tags`,
    );
  }
  if (parsed.length === 0) {
    throw new Error(`idTagPool.file "${filePath}" holds no tags`);
  }
  return parsed as string[];
}
