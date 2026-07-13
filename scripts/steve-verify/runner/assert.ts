// #179: the typed assertion DSL lives in
// src/cp/application/verification/assert.ts so the in-simulator assertion
// engine and this CI harness share ONE semantics. Re-exported here so the
// runner's existing `./assert` imports resolve unchanged. See ocpp.ts for why
// this shim is being (re)introduced now.
export * from "../../../src/cp/application/verification/assert";
