#!/usr/bin/env bun
// A stand-alone auto-acking mock CSMS for fleet-bench runs (#626).
//
// It is the mock of `smokeHarness.ts`, run in its own process so that the
// CSMS does not share an event loop with the daemon under test. It answers
// every CALL at once, so the latency a run reports is the daemon's, not the
// CSMS's. It enforces nothing (no subprotocol, no schema, no CALLERROR): use a
// real CSMS to check version and handshake behaviour.
//
//   bun scripts/bench/mockCsmsServer.ts        # prints: MOCK_CSMS ws://127.0.0.1:<port>/
import { startMockCsms } from "./smokeHarness.ts";

const csms = startMockCsms();
console.log(`MOCK_CSMS ${csms.wsUrl}`);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
