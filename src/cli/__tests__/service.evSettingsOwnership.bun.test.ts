import { describe, expect, it } from "bun:test";

import {
  CLIChargePointService,
  shouldReleaseEvSettingsOverride,
} from "../service";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";
import {
  EVSettings,
  getDefaultEVSettings,
} from "../../cp/domain/connector/EVSettings";

/**
 * Who owns a connector's EV settings override (#105, #314).
 *
 * The override is one boolean on the connector, and three shipped
 * formulations tried to reconstruct its owner from the state around it:
 * presence of a definition declaring `evSettings`, then identity of the
 * installed definition, then the replacement's *declaration*. Each was right
 * only for the cases someone had thought of. The rule now compares run ids,
 * and the owner is written only where a claim actually happens.
 *
 * The pure function's own table is nearly trivial by design — that is the
 * point. The cases that broke live one level up, at the service, because
 * "installed but has not run" is a distinction only the service can make: a
 * replacement definition is installed *before* it runs, and may never run.
 * So the service-level tests below, not the table, are what pin the fix.
 */
function completingScenario(
  id: string,
  evSettings?: Partial<EVSettings>,
): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
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
        id: "mv-1",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 1 },
        data: { label: "MV", value: 100, sendMessage: false },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "mv-1" },
      { id: "e2", source: "mv-1", target: "end-1" },
    ],
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    ...(evSettings
      ? { evSettings: { ...getDefaultEVSettings(), ...evSettings } }
      : {}),
  } as ScenarioDefinition;
}

/** Claims the override, then parks — still running, still the owner. */
function parkedScenario(
  id: string,
  evSettings: Partial<EVSettings>,
): ScenarioDefinition {
  const base = completingScenario(id, evSettings);
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 1 },
        data: { label: "wait", delaySeconds: 60 },
      },
      base.nodes[2],
    ],
    edges: [
      { id: "e1", source: "start-1", target: "delay-1" },
      { id: "e2", source: "delay-1", target: "end-1" },
    ],
  } as ScenarioDefinition;
}

/**
 * No `--state-db`: nothing here reads persisted state, and the override the
 * tests probe is in-memory on the connector either way.
 */
function newService(): CLIChargePointService {
  return new CLIChargePointService({
    cpId: "cp-ev-owner",
    wsUrl: "ws://127.0.0.1:65534/never",
    connectors: 1,
    vendor: "v",
    model: "m",
    basicAuth: null,
  });
}

/**
 * The only observable of "the override was released".
 *
 * `Connector._evSettingsOverridden` is private and has no getter — its whole
 * purpose is to make `applyDefaultEvSettings` a no-op — so the way to ask
 * whether it is still set is to push a default through and see whether it
 * lands. Returns the connector's targetSoc after the attempt: `probe` means
 * released, anything else means still overridden.
 */
function defaultPropagationLands(
  svc: CLIChargePointService,
  probe: number,
): boolean {
  svc.applyDefaultEVSettings({ ...getDefaultEVSettings(), targetSoc: probe });
  return svc.getEVSettings(1).targetSoc === probe;
}

/** Let the run reach its `finally`; the graph has no waits of its own. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe("shouldReleaseEvSettingsOverride (#105, #314)", () => {
  it("releases exactly when the ending run is the run that claimed", () => {
    const mine = "s#1757200000000-aaaa";
    const other = "s#1757200000001-bbbb";

    expect({
      // Ordinary completion: I claimed, nothing has claimed since.
      mineStillOwner: shouldReleaseEvSettingsOverride(mine, mine),
      // Someone else claimed since — a replacement run that actually applied
      // its own evSettings. Clearing would unmark a live override.
      ownedBySomeoneElse: shouldReleaseEvSettingsOverride(mine, other),
      // Nobody owns it: either this run never declared evSettings, or an
      // operator's set_ev_settings took it over (#105).
      unowned: shouldReleaseEvSettingsOverride(mine, null),
      // No ending run id at all (the stop path's `?? ""` fallback, or a
      // caller with nothing to compare). Matches nothing.
      noEndingRun: shouldReleaseEvSettingsOverride("", other),
      bothAbsent: shouldReleaseEvSettingsOverride(null, null),
    }).toEqual({
      mineStillOwner: true,
      ownedBySomeoneElse: false,
      unowned: false,
      noEndingRun: false,
      bothAbsent: false,
    });
  });

  it("distinguishes two runs of the same scenario", () => {
    // Run ids are minted per invocation, so re-running one scenario does not
    // let the earlier run release what the later one claimed.
    const first = "same-scenario#1757200000000-aaaa";
    const second = "same-scenario#1757200000000-bbbb";
    expect(shouldReleaseEvSettingsOverride(first, second)).toBe(false);
  });
});

describe("EV settings override ownership through the service (#105, #314)", () => {
  it("a run that claimed the override releases it when it completes", async () => {
    const svc = newService();
    const id = svc.loadScenario(
      1,
      completingScenario("solo", { targetSoc: 55 }),
    );
    svc.runScenario(1, id);
    // The claim lands inside runScenario's synchronous segment: the executor
    // applies declared evSettings before its first `await` yields.
    expect(svc.getEVSettings(1).targetSoc).toBe(55);
    await settle();

    expect(svc.getScenarioRunResult(id)).not.toBeNull();
    expect(defaultPropagationLands(svc, 99)).toBe(true);
    svc.cleanup(true);
  });

  it("a replacement that is installed but never runs does not keep the override marked", async () => {
    // The ordering case (#314). A new definition with the same id is loaded
    // while the old one is running: `_scenarios` holds the replacement before
    // it has run, and the live executor blocks its auto-start, so it may never
    // run at all. Both definitions declare evSettings — the combination under
    // which every declaration-based rule leaves the old run's override marked
    // forever, because it reads the replacement's *declaration* as a claim.
    const svc = newService();
    const id = svc.loadScenario(
      1,
      completingScenario("hot", { targetSoc: 55 }),
    );
    svc.runScenario(1, id);
    expect(svc.getEVSettings(1).targetSoc).toBe(55);

    svc.loadScenario(1, completingScenario("hot", { targetSoc: 77 }), {
      autoStart: false,
    });
    await settle();

    // The replacement never applied anything, so the connector still shows the
    // outgoing run's settings — "installed" is not "has taken effect".
    expect(svc.getEVSettings(1).targetSoc).toBe(55);
    // …and the run that did claim has ended, so the override is released.
    expect(defaultPropagationLands(svc, 99)).toBe(true);
    svc.cleanup(true);
  });

  it("a run that actually claimed since keeps its override when the earlier run ends", async () => {
    const svc = newService();
    const first = svc.loadScenario(
      1,
      completingScenario("first", { targetSoc: 55 }),
    );
    svc.runScenario(1, first);
    // A second scenario on the same connector claims the override for itself
    // and then parks on a long delay, so it is still running — and still the
    // owner — when the first run finishes.
    const second = svc.loadScenario(
      1,
      parkedScenario("second", { targetSoc: 77 }),
    );
    svc.runScenario(1, second);
    expect(svc.getEVSettings(1).targetSoc).toBe(77);
    await settle();

    expect(svc.getScenarioRunResult(first)).not.toBeNull();
    // The first run has ended and must not have taken the second run's
    // override with it.
    expect(defaultPropagationLands(svc, 99)).toBe(false);
    expect(svc.getEVSettings(1).targetSoc).toBe(77);
    svc.cleanup(true);
  });

  it("an operator's set_ev_settings during a run survives that run (#105)", async () => {
    const svc = newService();
    const id = svc.loadScenario(
      1,
      completingScenario("mid", { targetSoc: 55 }),
    );
    svc.runScenario(1, id);
    // The operator takes the override over while the run is in flight. The
    // last claim wins, and it is no longer the run's.
    svc.setEVSettings(1, { ...getDefaultEVSettings(), targetSoc: 66 });
    await settle();

    expect(svc.getScenarioRunResult(id)).not.toBeNull();
    expect(defaultPropagationLands(svc, 99)).toBe(false);
    expect(svc.getEVSettings(1).targetSoc).toBe(66);
    svc.cleanup(true);
  });

  it("a run that declared no evSettings never releases an operator's override (#105)", async () => {
    const svc = newService();
    svc.setEVSettings(1, { ...getDefaultEVSettings(), targetSoc: 66 });
    const id = svc.loadScenario(1, completingScenario("plain"));
    svc.runScenario(1, id);
    await settle();

    expect(svc.getScenarioRunResult(id)).not.toBeNull();
    expect(defaultPropagationLands(svc, 99)).toBe(false);
    expect(svc.getEVSettings(1).targetSoc).toBe(66);
    svc.cleanup(true);
  });

  it("a manually stopped run releases what it claimed", async () => {
    const svc = newService();
    const id = svc.loadScenario(
      1,
      completingScenario("stopped", { targetSoc: 55 }),
    );
    svc.runScenario(1, id);
    expect(svc.getEVSettings(1).targetSoc).toBe(55);
    svc.stopScenario(1, id);

    expect(defaultPropagationLands(svc, 99)).toBe(true);
    await settle();
    svc.cleanup(true);
  });
});
