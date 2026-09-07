import { describe, expect, it } from "bun:test";

import { CLIChargePointService, scenarioPositionIsOwnedBy } from "../service";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * `onPersisted` is called exactly once, and a throwing callback cannot turn a
 * successful write into a reported failure (#314).
 *
 * The contract `loadScenario` establishes is that `applied` is a claim about
 * durable state: the bytes landed. A `.then().catch()` chain quietly broke it,
 * because `.catch` also sees whatever the success handler throws — so a write
 * that had settled, followed by a callback that threw, was logged as a
 * persistence failure and reported a second time as the error. `--watch`'s
 * callback reaches `eventEnvelopeSchema.parse`, which throws on an oversized
 * snapshot, so that path was reachable: a failure to *announce* a reload was
 * reported as a failure to *persist* it.
 */
function definition(id: string): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 1 },
        data: { label: "E" },
      },
    ],
    edges: [{ id: "e1", source: "start-1", target: "end-1" }],
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
  } as ScenarioDefinition;
}

function newService(): CLIChargePointService {
  return new CLIChargePointService({
    cpId: "cp-persist-report",
    wsUrl: "ws://127.0.0.1:65534/never",
    connectors: 1,
    vendor: "v",
    model: "m",
    basicAuth: null,
  });
}

describe("loadScenario's onPersisted contract (#314)", () => {
  it("reports success once, even when the callback throws", async () => {
    const svc = newService();
    const reported: Array<unknown | null> = [];
    svc.loadScenario(1, definition("throwing-callback"), {
      autoStart: false,
      onPersisted: (error) => {
        reported.push(error);
        // Exactly what `--watch`'s callback does when the resulting snapshot
        // fails envelope validation: it throws, from inside the success path.
        throw new Error("finishApply blew up");
      },
    });

    // Two turns, so a rejection handler chained after the success handler
    // would have had every chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // One report, and it says the write succeeded — which it did. Under a
    // `.then().catch()` chain this was `[null, Error("finishApply blew up")]`:
    // the same load reported applied and then rejected.
    expect(reported).toEqual([null]);
    svc.cleanup(true);
  });

  it("reports once on success with a well-behaved callback", async () => {
    const svc = newService();
    const reported: Array<unknown | null> = [];
    svc.loadScenario(1, definition("ordinary"), {
      autoStart: false,
      onPersisted: (error) => {
        reported.push(error);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reported).toEqual([null]);
    svc.cleanup(true);
  });
});

/**
 * The connector's scenario position is owned by the run whose key it carries
 * (#314).
 *
 * The third field on this branch to need an owner. The position is per
 * *connector* while the cleanup that clears it is per *run*, and a run's
 * `finally` is a queued microtask — so between one run stopping and its
 * cleanup, another scenario can acquire the connector. `_executors` cannot
 * answer "is this still mine": it is keyed by scenarioId, so a *different*
 * scenario starting on the same connector leaves the outgoing id's slot empty
 * and any guard reading it concludes nobody owns anything.
 */
describe("scenarioPositionIsOwnedBy (#314)", () => {
  const position = (scenarioKey: string) => ({
    scenarioKey,
    lastCompletedNodeId: "node-a",
    executedNodes: ["node-a"],
  });

  it("clears only what the ending run acquired", () => {
    expect({
      // Ordinary completion: the position is still the ending run's.
      mine: scenarioPositionIsOwnedBy(position("run-a"), "run-a"),
      // Another scenario acquired the connector while this run's `finally`
      // sat queued. Clearing would throw away its checkpoint, and with
      // `--state-db` the next boot would replay nodes it had completed.
      someoneElses: scenarioPositionIsOwnedBy(position("run-b"), "run-a"),
      // Nothing stored: vacuously mine, nothing to take from anyone.
      absent: scenarioPositionIsOwnedBy(undefined, "run-a"),
    }).toEqual({
      mine: true,
      someoneElses: false,
      absent: true,
    });
  });
});
