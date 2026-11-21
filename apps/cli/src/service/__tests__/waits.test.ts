import { describe, expect, it } from "vitest";
import type { CLIEvent, EventHandler } from "../cliEvents";
import { eventMatches, waitFor } from "../waits";

function source(status: { state?: string } | null = null) {
  const handlers = new Set<EventHandler>();
  return {
    emit: (evt: CLIEvent) => handlers.forEach((h) => h(evt)),
    handlers,
    source: {
      onEvent: (h: EventHandler) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      readScenarioStatus: () => status,
    },
  };
}

const state = (s: string): CLIEvent => ({
  event: "scenario_state_changed",
  data: {
    connectorId: 1,
    scenarioId: "sc",
    runId: "r",
    state: s,
    nodeId: "n",
    expectation: null,
  },
});

describe("waitFor (#1090)", () => {
  it("matches an event by name and by shallow data", () => {
    const evt: CLIEvent = {
      event: "connector_status",
      data: { connectorId: 1, status: "Charging", previousStatus: "Preparing" },
    };
    expect(eventMatches(evt, { event: "connector_status" })).toBe(true);
    expect(
      eventMatches(evt, {
        event: "connector_status",
        match: { status: "Charging" },
      }),
    ).toBe(true);
    expect(
      eventMatches(evt, {
        event: "connector_status",
        match: { status: "Available" },
      }),
    ).toBe(false);
    expect(eventMatches(evt, { event: "connected" })).toBe(false);
  });

  it("answers at once when the scenario is already in the state, and unsubscribes", async () => {
    const s = source({ state: "completed" });
    const result = await waitFor(s.source, {
      scenario: { connector: 1, scenarioId: "sc", state: "completed" },
    });
    expect(result.matched).toBe(true);
    expect(s.handlers.size).toBe(0);
  });

  it("waits for the state change, ignoring other scenarios and states", async () => {
    const s = source({ state: "running" });
    const pending = waitFor(s.source, {
      scenario: { connector: 1, scenarioId: "sc", state: "completed" },
      timeoutMs: 1000,
    });
    s.emit(state("waiting"));
    s.emit({
      ...state("completed"),
      data: { ...(state("completed").data as object), scenarioId: "other" },
    } as CLIEvent);
    s.emit(state("completed"));
    const result = await pending;
    expect(result).toMatchObject({
      matched: true,
      event: "scenario_state_changed",
    });
    expect(s.handlers.size).toBe(0);
  });

  it("times out as a result", async () => {
    const s = source();
    const result = await waitFor(s.source, { event: "x", timeoutMs: 10 });
    expect(result).toEqual({ matched: false, timedOut: true });
    expect(s.handlers.size).toBe(0);
  });
});
