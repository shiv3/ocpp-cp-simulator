// src/cli/exportK6/runtime/index.ts
// Public surface of the emitted runtime — everything the generated entry
// script imports.
export { OcppChargePoint } from "./ocppClient";
export { runScenario } from "./interpreter";
export { buildOptions } from "./profiles";
export { evaluateAssertions } from "./assertions";
export { scenarioSuccess } from "./metrics";
export type { CpIdentity, ScenarioJson, Wire } from "./types";

import { wire16 } from "./wire/v16";
import { SharedArray } from "k6/data";
import type { CpIdentity, Wire } from "./types";

export function createWire(version: string): Wire {
  if (version === "1.6") return wire16;
  throw new Error(
    `OCPP version "${version}" is not supported by this runtime (Phase 1 supports 1.6)`,
  );
}

export function requiredEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

/** Init-context only (uses open()). Returns null when no CP_IDS_FILE is set. */
export function loadIdentities(
  env: Record<string, string | undefined>,
): CpIdentity[] | null {
  const file = env.CP_IDS_FILE;
  if (file === undefined || file === "") return null;
  const shared = new SharedArray<CpIdentity>("cp-identities", () => {
    const parsed: unknown = JSON.parse(open(file));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        `${file} must be a non-empty JSON array of {cpId, basicPassword?}`,
      );
    }
    return parsed as CpIdentity[];
  });
  // SharedArray is array-like; materialize a plain readonly view for indexing.
  return shared as unknown as CpIdentity[];
}

export function resolveIdentity(
  identities: CpIdentity[] | null,
  env: Record<string, string | undefined>,
  vu: number,
): CpIdentity {
  if (identities !== null) return identities[(vu - 1) % identities.length];
  const template = env.CP_ID_TEMPLATE ?? "CP-${__VU}";
  // Global regex replace, not replaceAll: the repo's browser tsconfig type-
  // checks this file against lib ES2020, which predates replaceAll (ES2021).
  const cpId = template.replace(/\$\{__VU\}/g, String(vu));
  const basicPassword = env.BASIC_AUTH_PASSWORD;
  return basicPassword !== undefined && basicPassword !== ""
    ? { cpId, basicPassword }
    : { cpId };
}
