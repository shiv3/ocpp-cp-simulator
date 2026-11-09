// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import statusTriggeredActions from "@ocpp-cp-simulator/core/utils/scenarios/status-triggered-actions.json";
import { deriveStepLayout } from "../../../lib/stepLayout";
import { forkScenario } from "../../../test/scenarioFixtures";
import StepsView, { type StepRunViewProps } from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;

async function render(
  props: Omit<StepRunViewProps, "layout">,
  def: ScenarioDefinition = forkScenario(),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StepsView layout={deriveStepLayout(def)} {...props} />);
  });
}

/** forkScenario with `[source, target]` edges swapped in by source. */
function rewired(...pairs: Array<[string, string]>): ScenarioDefinition {
  const def = forkScenario();
  const sources = new Set(pairs.map(([source]) => source));
  return {
    ...def,
    edges: [
      ...def.edges.filter((e) => !sources.has(e.source)),
      ...pairs.map(([source, target]) => ({
        id: `${source}->${target}`,
        source,
        target,
      })),
    ],
  };
}

const stepIds = (el: Element | null) =>
  Array.from(el?.querySelectorAll("[data-step-id]") ?? []).map((b) =>
    b.getAttribute("data-step-id"),
  );

const box = (id: string) =>
  container.querySelector<HTMLElement>(`[data-step-id="${id}"]`)!;

describe("StepsView", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("numbers the boxes main first, then each branch", async () => {
    await render({});
    const numbers = Array.from(
      container.querySelectorAll("[data-step-id]"),
    ).map((el) => [el.getAttribute("data-step-id"), el.textContent?.[0]]);
    expect(numbers).toEqual([
      ["plug", "1"],
      ["status", "2"],
      ["charge", "3"],
      ["meter", "4"],
      ["wait", "5"],
    ]);
    // Title and summary.
    expect(box("plug").textContent).toContain("Connector Plug");
    expect(box("plug").textContent).toContain("plugin");
  });

  it("marks done with a check, the current step with the state pill, todo dimmed", async () => {
    await render({
      state: "waiting",
      currentNodeId: "charge",
      executedNodeIds: ["plug", "status", "charge"],
    });
    expect(box("plug").dataset.phase).toBe("done");
    expect(box("plug").querySelector('[aria-label="done"]')).toBeTruthy();
    expect(box("charge").dataset.phase).toBe("current");
    expect(box("charge").textContent).toContain("waiting");
    expect(box("charge").querySelector(".ring-cx-amber")).toBeTruthy();
    expect(box("meter").dataset.phase).toBe("todo");
    expect(box("meter").querySelector(".opacity-55")).toBeTruthy();
    expect(box("plug").querySelector(".opacity-55")).toBeNull();
  });

  it("puts each branch in a column under a lane tag with done/total", async () => {
    await render({
      state: "running",
      currentNodeId: "meter",
      executedNodeIds: ["plug", "status", "charge", "wait", "meter"],
    });
    const tags = Array.from(
      container.querySelectorAll('[data-testid="lane-tag"]'),
    ).map((el) => el.textContent);
    expect(tags).toEqual(["ACharge path1/2", "BBranch B1/1"]);
    const lanes = container.querySelectorAll("[data-lane]");
    expect(lanes[0].querySelectorAll("[data-step-id]")).toHaveLength(2);
    expect(lanes[1].querySelectorAll("[data-step-id]")).toHaveLength(1);
  });

  it("without a run, shows no phase and the step count per branch", async () => {
    await render({});
    expect(box("plug").dataset.phase).toBe("plain");
    expect(container.querySelector(".opacity-55")).toBeNull();
    expect(
      container.querySelector('[data-testid="lane-tag"]')?.textContent,
    ).toBe("ACharge path2");
  });

  it("encloses exactly the looped steps in a loop block, the steps before it above", async () => {
    await render(
      { state: "running", currentNodeId: "delay-10s", executedNodeIds: [] },
      statusTriggeredActions as unknown as ScenarioDefinition,
    );
    const blocks = container.querySelectorAll("[data-loop-block]");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.getAttribute("data-loop-to")).toBe("notification-heartbeat");
    expect(stepIds(block)).toEqual(["notification-heartbeat", "delay-10s"]);
    // The Status Trigger runs once, above the block, in the same lane.
    const lane = container.querySelector('[data-lane-list="main"]')!;
    expect(stepIds(lane)).toEqual([
      "trigger-available",
      "notification-heartbeat",
      "delay-10s",
    ]);
    expect(block.contains(box("trigger-available"))).toBe(false);
    expect(block.textContent).toContain("Repeat forever");
    expect(block.textContent).toContain("Back to step 2");
    // Heartbeat is not a wait: no "waits first" claim.
    expect(block.textContent).not.toContain("waits");
    expect(block.getAttribute("aria-label")).toBe("Repeated steps 2 to 3");
    // No separate "Then back to" note for an enclosed loop.
    expect(container.querySelector("[data-link-to]")).toBeNull();
  });

  it("a loop holding a switch says Repeat, not forever, and names its group", async () => {
    const base = statusTriggeredActions as unknown as ScenarioDefinition;
    const def: ScenarioDefinition = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "notification-heartbeat"
          ? ({
              ...n,
              type: "switch",
              data: { label: "Route", value: "a", cases: ["a"] },
            } as unknown as typeof n)
          : n,
      ),
    };
    await render({}, def);
    const block = container.querySelector("[data-loop-block]")!;
    expect(block.textContent).toContain("Repeat");
    expect(block.textContent).not.toContain("Repeat forever");
    const group = block.querySelector('[role="group"]')!;
    const label = document.getElementById(
      group.getAttribute("aria-labelledby")!,
    );
    expect(label?.textContent).toBe("Repeat");
  });

  it("a loop back to the lane's first step encloses the whole lane", async () => {
    // Branch A: charge → meter → back to charge.
    await render({}, rewired(["meter", "charge"]));
    const lane = container.querySelector('[data-lane-list="0"]')!;
    const block = lane.querySelector("[data-loop-block]")!;
    expect(stepIds(block)).toEqual(["charge", "meter"]);
    expect(stepIds(lane)).toEqual(["charge", "meter"]);
    expect(block.textContent).toContain("Back to step 3");
    // Only that lane loops.
    expect(container.querySelectorAll("[data-loop-block]")).toHaveLength(1);
  });

  it("says a loop that starts at a wait waits there each round", async () => {
    // Branch B's only step, a Delay, loops on itself.
    await render({}, rewired(["wait", "wait"]));
    const block = container.querySelector('[data-loop-to="wait"]')!;
    expect(stepIds(block)).toEqual(["wait"]);
    expect(block.textContent).toContain("each round waits at step 5 first");
  });

  it("a link to another lane is a note, not a loop block", async () => {
    // Branch B goes back to the chain's first step; nothing loops in a lane.
    await render({}, rewired(["wait", "plug"]));
    expect(container.querySelector("[data-loop-block]")).toBeNull();
    const back = container.querySelector('[data-link-to="plug"]')!;
    expect(back.textContent).toBe("Then back to step 1");
    expect(container.querySelector('[data-lane="1"]')!.contains(back)).toBe(
      true,
    );
  });

  it("a join into an earlier branch reads 'Then on to step N'", async () => {
    await render({}, rewired(["wait", "meter"]));
    expect(container.querySelector("[data-loop-block]")).toBeNull();
    expect(container.querySelector('[data-link-to="meter"]')?.textContent).toBe(
      "Then on to step 4",
    );
  });
});
