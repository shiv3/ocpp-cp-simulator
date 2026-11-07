import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";

/**
 * Turn the default export of a loaded behavior module into behaviors: one
 * behavior or an array of them. Throws on a bad shape. `label` names the
 * module (a file, a blob) in the message.
 */
export function behaviorsOfModule(label: string, mod: unknown): Behavior[] {
  const exported = (mod as { default?: unknown } | null)?.default;
  const list = Array.isArray(exported) ? exported : [exported];
  return list.map((item, i) => {
    const b = item as Partial<Behavior> | undefined;
    if (
      !b ||
      typeof b !== "object" ||
      b.api !== 1 ||
      typeof b.id !== "string"
    ) {
      throw new Error(
        `${label}: the default export must be a behavior ({ api: 1, id, ... })` +
          ` or an array of them (item ${i})`,
      );
    }
    return b as Behavior;
  });
}
