#!/usr/bin/env bun
// Generate db-spec.json from fixtures.json: what a caller needs to register
// matching charging ports in a database. Run: bun scripts/dev-fixtures/gen-db-spec.ts
import fixtures from "./fixtures.json" with { type: "json" };

const spec = fixtures.cps.map((cp) => ({
  cpId: cp.cpId,
  connectors: cp.connectors,
  chargerType: cp.chargerType,
  maxPowerKw: cp.maxPowerKw,
  vendor: cp.vendor,
  model: cp.model,
}));
await Bun.write(
  new URL("./db-spec.json", import.meta.url),
  `${JSON.stringify(spec, null, 2)}\n`,
);
console.log(`db-spec.json: ${spec.length} charge points`);
