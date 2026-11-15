// Read-only scenario introspection over OCPP (#927): 1.6 GetConfiguration keys
// and 2.x SimulatorCtrlr variables over one read model.
import { afterEach, describe, expect, test } from "bun:test";
import type {
  ActiveRunState,
  DiagnosticsSources,
  ScenarioLastRunView,
  ScenarioRunView,
} from "../../cp/domain/charge-point/DiagnosticsSources";
import { SCENARIO_CONFIG_KEYS } from "../../cp/domain/charge-point/scenarioReadModel";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

/** A mutable stand-in for the daemon's scenario runtime. */
function runtime() {
  const state = {
    runs: [] as ScenarioRunView[],
    last: null as ScenarioLastRunView | null,
  };
  const sources: DiagnosticsSources = {
    scenarios: {
      installed: () => [
        { id: "s1", name: "one", connectorId: 1, enabled: true },
      ],
      activeRuns: () => state.runs,
      lastRun: () => state.last,
      definition: () => ({ secret: "never in a configuration answer" }),
    },
  };
  const start = (
    connectorId: number,
    runId: string,
    runState: ActiveRunState = "running",
    stepNodeId: string | null = "n1",
  ) =>
    state.runs.push({
      runId,
      scenarioId: `s${connectorId}`,
      connectorId,
      state: runState,
      stepNodeId,
    });
  return { state, sources, start };
}

async function station(version: "1.6" | "2.0.1", sources?: DiagnosticsSources) {
  return runBehavior({
    version,
    connectors: 2,
    beforeConnect: (cp) => {
      if (sources) cp.setDiagnosticsSources(sources);
    },
  });
}

async function read16(r: BehaviorRun): Promise<Record<string, string>> {
  const answer = await r.call("GetConfiguration", {
    key: [...SCENARIO_CONFIG_KEYS],
  });
  const p = answer.payload as {
    configurationKey?: { key: string; readonly: boolean; value: string }[];
    unknownKey?: string[];
  };
  expect(p.unknownKey ?? []).toEqual([]);
  for (const k of p.configurationKey ?? []) expect(k.readonly).toBe(true);
  return Object.fromEntries(
    (p.configurationKey ?? []).map((k) => [k.key, k.value]),
  );
}

async function read2(
  r: BehaviorRun,
  variable: string,
): Promise<{ status: string; value?: string }> {
  const answer = await r.call("GetVariables", {
    getVariableData: [
      { component: { name: "SimulatorCtrlr" }, variable: { name: variable } },
    ],
  });
  const res = (
    answer.payload as {
      getVariableResult: { attributeStatus: string; attributeValue?: string }[];
    }
  ).getVariableResult[0]!;
  return { status: res.attributeStatus, value: res.attributeValue };
}

describe("OCPP 1.6 scenario keys", () => {
  test("idle: selected is empty, status idle, no historic run reported as active", async () => {
    const rt = runtime();
    run = await station("1.6", rt.sources);
    expect(await read16(run)).toEqual({
      SimScenarioId: "",
      SimScenarioStatus: "idle",
      SimScenarioRunCount: "0",
      SimScenarioRunId: "",
      SimScenarioStep: "",
      SimScenarioConnectorId: "",
      SimScenarioRuns: "",
      SimScenarioLastRunId: "",
      SimScenarioLastStatus: "none",
    });
  });

  test("transitions: running, waiting, multiple, back to idle with a last run", async () => {
    const rt = runtime();
    run = await station("1.6", rt.sources);
    rt.start(1, "run-1");
    let v = await read16(run);
    expect(v).toMatchObject({
      SimScenarioStatus: "running",
      SimScenarioRunCount: "1",
      SimScenarioRunId: "run-1",
      SimScenarioStep: "n1",
      SimScenarioConnectorId: "1",
      SimScenarioRuns: "1:run-1:running",
    });
    rt.state.runs[0] = {
      ...rt.state.runs[0]!,
      state: "waiting",
      stepNodeId: "wait",
    };
    v = await read16(run);
    expect(v).toMatchObject({
      SimScenarioStatus: "waiting",
      SimScenarioStep: "wait",
    });
    rt.start(2, "run-2", "paused");
    v = await read16(run);
    expect(v).toMatchObject({
      SimScenarioStatus: "multiple",
      SimScenarioRunCount: "2",
      SimScenarioRunId: "",
      SimScenarioConnectorId: "",
      SimScenarioRuns: "1:run-1:waiting,2:run-2:paused",
    });
    rt.state.last = {
      runId: "run-2",
      scenarioId: "s2",
      connectorId: 2,
      outcome: "failed",
    };
    rt.state.runs = [];
    v = await read16(run);
    expect(v).toMatchObject({
      SimScenarioStatus: "idle",
      SimScenarioRunId: "",
      SimScenarioLastRunId: "run-2",
      SimScenarioLastStatus: "failed",
    });
  });

  test("a cancelled run is the last run, never an active one", async () => {
    const rt = runtime();
    run = await station("1.6", rt.sources);
    rt.state.last = {
      runId: "run-9",
      scenarioId: "s1",
      connectorId: 1,
      outcome: "stopped",
    };
    const v = await read16(run);
    expect(v.SimScenarioStatus).toBe("idle");
    expect(v.SimScenarioRunId).toBe("");
    expect(v.SimScenarioLastStatus).toBe("stopped");
  });

  test("the answer is bounded and leaks no scenario definition", async () => {
    const rt = runtime();
    run = await station("1.6", rt.sources);
    for (let i = 0; i < 40; i++) rt.start(i + 1, `run-${"x".repeat(20)}-${i}`);
    const v = await read16(run);
    expect(v.SimScenarioRuns!.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(v)).not.toContain("never in a configuration answer");
  });

  test("writes are rejected for every key", async () => {
    const rt = runtime();
    run = await station("1.6", rt.sources);
    for (const key of SCENARIO_CONFIG_KEYS) {
      const answer = await run.call("ChangeConfiguration", { key, value: "x" });
      expect({
        key,
        status: (answer.payload as { status: string }).status,
      }).toEqual({
        key,
        status: "Rejected",
      });
    }
  });

  test("a station without a scenario runtime has no such keys (existing behavior unaffected)", async () => {
    run = await station("1.6");
    const answer = await run.call("GetConfiguration", {
      key: ["SimScenarioStatus"],
    });
    expect(answer.payload).toMatchObject({ unknownKey: ["SimScenarioStatus"] });
    const all = await run.call("GetConfiguration", {});
    expect(JSON.stringify(all.payload).includes("SimScenario")).toBe(false);
  });
});

describe("OCPP 2.x SimulatorCtrlr variables", () => {
  test("share the read model: same values as the 1.6 keys", async () => {
    const rt = runtime();
    run = await station("2.0.1", rt.sources);
    expect(await read2(run, "ScenarioStatus")).toEqual({
      status: "Accepted",
      value: "idle",
    });
    rt.start(1, "run-1", "waiting", "wait");
    expect(await read2(run, "ScenarioStatus")).toEqual({
      status: "Accepted",
      value: "waiting",
    });
    expect(await read2(run, "ScenarioRunId")).toEqual({
      status: "Accepted",
      value: "run-1",
    });
    expect(await read2(run, "ScenarioStep")).toEqual({
      status: "Accepted",
      value: "wait",
    });
    expect(await read2(run, "ScenarioConnectorId")).toEqual({
      status: "Accepted",
      value: "1",
    });
    rt.start(2, "run-2");
    expect(await read2(run, "ScenarioStatus")).toEqual({
      status: "Accepted",
      value: "multiple",
    });
    expect(await read2(run, "ScenarioRuns")).toEqual({
      status: "Accepted",
      value: "1:run-1:waiting,2:run-2:running",
    });
    rt.state.runs = [];
    rt.state.last = {
      runId: "run-2",
      scenarioId: "s2",
      connectorId: 2,
      outcome: "passed",
    };
    expect(await read2(run, "ScenarioLastStatus")).toEqual({
      status: "Accepted",
      value: "passed",
    });
    expect(await read2(run, "ScenarioRunId")).toEqual({
      status: "Accepted",
      value: "",
    });
  });

  test("an unknown variable and the read-only rule", async () => {
    const rt = runtime();
    run = await station("2.0.1", rt.sources);
    expect((await read2(run, "NoSuchVariable")).status).toBe("UnknownVariable");
    const answer = await run.call("SetVariables", {
      setVariableData: [
        {
          component: { name: "SimulatorCtrlr" },
          variable: { name: "ScenarioStatus" },
          attributeValue: "running",
        },
      ],
    });
    const res = (
      answer.payload as { setVariableResult: { attributeStatus: string }[] }
    ).setVariableResult[0]!;
    expect(res.attributeStatus).toBe("Rejected");
  });

  test("a station without a scenario runtime holds no value for them", async () => {
    run = await station("2.0.1");
    expect((await read2(run, "ScenarioStatus")).status).toBe("Rejected");
  });
});
