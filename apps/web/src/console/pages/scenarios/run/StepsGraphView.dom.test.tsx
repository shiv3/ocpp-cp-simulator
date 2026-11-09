// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import {
  deadLanes,
  ifElseReconverges,
  loopWithTwoExits,
  switchInLane,
  withDetached,
} from "../../../test/treeFixtures";
import StepsGraphView from "./StepsGraphView";
import type { StepTreeViewProps } from "./stepVisuals";

let root: Root | null = null;
let container: HTMLElement;

async function render(
  def: ScenarioDefinition,
  props: Omit<StepTreeViewProps, "tree"> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StepsGraphView tree={recognizeBlockTree(def)} {...props} />);
  });
}

const card = (id: string) =>
  container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const left = (id: string) => parseFloat(card(id).style.left);
const top = (id: string) => parseFloat(card(id).style.top);

describe("StepsGraphView (block tree)", () => {
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

  it("draws one card per step, a start dot, an end ring per lane end, and lane tags", async () => {
    await render(switchInLane());
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(6);
    expect(container.querySelectorAll("[data-graph-start]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-graph-end]")).toHaveLength(3);
    const tags = Array.from(
      container.querySelectorAll("[data-lane-condition]"),
    ).map((el) => el.textContent);
    expect(tags).toEqual([
      'case-0 → "Accepted"',
      'case-0 → "Charging"',
      "default",
      "default",
    ]);
    // The nested switch's lanes stand under its own lane, left of b.
    expect(left("x")).toBeLessThan(left("inner"));
    expect(left("y")).toBeGreaterThan(left("inner"));
    expect(left("b")).toBeGreaterThan(left("y"));
    expect(top("x")).toBeGreaterThan(top("inner"));
  });

  it("a reconverging switch: lanes meet at a merge point above the merge step", async () => {
    await render(ifElseReconverges());
    expect(container.querySelectorAll("[data-graph-merge]")).toHaveLength(1);
    expect(left("merge")).toBe(left("check"));
    expect(top("merge")).toBeGreaterThan(Math.max(top("ok"), top("ko")));
  });

  it("a loop: a tinted rectangle, a labelled return arc, a lane that leaves it outside", async () => {
    await render(loopWithTwoExits());
    const rect = container.querySelector('[data-graph-loop="head"]')!;
    const right =
      Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"));
    expect(left("bye")).toBeGreaterThan(right);
    expect(left("again") + 228).toBeLessThanOrEqual(right);
    expect(
      container
        .querySelector('[data-loop-arc="head"]')
        ?.getAttribute("data-edge-id"),
    ).toBe("again->head");
    const label = container.querySelector(
      '[data-loop-block][data-loop-to="head"]',
    )!;
    expect(label.textContent).toContain("Repeat");
    expect(label.textContent).not.toContain("forever");
    expect(label.getAttribute("aria-label")).toBe("Repeated steps 2 to 4");
    // case-1 (the way on) and default (bye) both leave the loop.
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="lane-tag"][data-leaves-loop] [data-lane-condition]',
        ),
      ).map((el) => el.textContent),
    ).toEqual(['case-1 → "stop"', "default"]);
  });

  it("mutes dead lanes, and lists steps nothing reaches on the right", async () => {
    await render(deadLanes());
    expect(
      Array.from(container.querySelectorAll("[data-dead-lane]")).map((el) =>
        el.getAttribute("data-lane"),
      ),
    ).toEqual(["2", "3"]);
    await act(async () => root?.unmount());
    await render(withDetached());
    expect(
      container.querySelector('[data-testid="detached-steps"]')?.textContent,
    ).toBe("Steps nothing reaches");
    expect(left("i1")).toBeGreaterThan(left("s1") + 228);
  });

  it("draws a jump as a dashed link", async () => {
    const def = switchInLane();
    def.edges = def.edges.map((e) =>
      e.id === "b->end" ? { ...e, id: "b->x", target: "x" } : e,
    );
    await render(def);
    const link = container.querySelector('path[data-link-from="b"]')!;
    expect(link.getAttribute("data-link-to")).toBe("x");
    expect(link.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(link.getAttribute("data-edge-id")).toBe("b->x");
  });

  it("strokes travelled paths in the lane colour at any depth, the rest in the strong border", async () => {
    await render(switchInLane(), {
      state: "running",
      currentNodeId: "x",
      executedNodeIds: ["route", "a", "inner", "x"],
    });
    const into = (id: string) =>
      container.querySelector(`svg[data-graph-edges] path[data-to="${id}"]`)!;
    // x is in lane A (index 0) of inner.
    expect(into("x").getAttribute("stroke")).toBe("var(--cx-accent)");
    expect(into("y").getAttribute("stroke")).toBe("var(--cx-border-strong)");
    expect(card("x").dataset.phase).toBe("current");
    expect(card("x").textContent).toContain("running");
    expect(card("route").dataset.phase).toBe("done");
  });
});
