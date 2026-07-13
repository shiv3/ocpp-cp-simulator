// #179: the OCPP-J frame model + log parser live in
// src/cp/application/verification/ocpp.ts so the in-simulator assertion engine
// and this CI harness share ONE semantics. Re-exported here so the runner's
// existing `./ocpp` imports resolve unchanged.
//
// (Phase 2a intended this shim but a botched baseline-measurement step
// discarded it before the commit, leaving a duplicate copy that then drifted
// when Phase 2b added parseFrameMessage to the src module. This restores the
// single source of truth.)
export * from "../../../src/cp/application/verification/ocpp";
