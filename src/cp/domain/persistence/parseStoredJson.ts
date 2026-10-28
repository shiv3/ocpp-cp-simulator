/**
 * A JSON column read back as a `T`, or null when it no longer parses to an
 * object whose `key` field is a string. Repositories skip such a row rather
 * than throw, so one bad row cannot make a whole listing fail (the
 * `BlueprintRepository` rule).
 */
export function parseStoredJson<T>(json: string, key: string): T | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)[key] === "string"
      ? (value as T)
      : null;
  } catch {
    return null;
  }
}
