// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { deriveStepLayout } from "../../../lib/stepLayout";
import { forkScenario } from "../../../test/scenarioFixtures";
import StepsGraphView from "./StepsGraphView";

let root: Root | null = null;
let container: HTMLElement;

async function render(
  props: Partial<React.ComponentProps<typeof StepsGraphView>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsGraphView layout={deriveStepLayout(forkScenario())} {...props} />,
    );
  });
}

const card = (id: string) =>
  container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;

describe("StepsGraphView", () => {
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

  it("draws one card per step and N + branches paths", async () => {
    await render();
    // 5 steps, 2 branches.
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(5);
    expect(
      container.querySelectorAll("svg[data-graph-edges] path"),
    ).toHaveLength(7);
    // A start dot and one end ring per branch.
    expect(container.querySelectorAll("[data-graph-start]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-graph-end]")).toHaveLength(2);
  });

  it("puts the second branch in its own lane, below the fork", async () => {
    await render();
    expect(card("charge").style.left).toBe(card("status").style.left);
    expect(card("wait").style.left).not.toBe(card("status").style.left);
    expect(parseFloat(card("wait").style.top)).toBe(
      parseFloat(card("charge").style.top),
    );
    expect(parseFloat(card("charge").style.top)).toBeGreaterThan(
      parseFloat(card("status").style.top) + 76,
    );
    const tags = Array.from(
      container.querySelectorAll('[data-testid="lane-tag"]'),
    ).map((el) => el.textContent);
    expect(tags).toEqual(["ACharge path", "BBranch B"]);
  });

  it("strokes travelled paths in the lane colour, the rest in the strong border", async () => {
    await render({
      state: "running",
      currentNodeId: "wait",
      executedNodeIds: ["plug", "status", "wait"],
    });
    const strokes = Array.from(
      container.querySelectorAll("svg[data-graph-edges] path"),
    ).map((p) => p.getAttribute("data-to"));
    expect(strokes).toContain("wait");
    const toWait = container.querySelector(
      'svg[data-graph-edges] path[data-to="wait"]',
    )!;
    expect(toWait.getAttribute("stroke")).toBe("var(--cx-purple)");
    const toCharge = container.querySelector(
      'svg[data-graph-edges] path[data-to="charge"]',
    )!;
    expect(toCharge.getAttribute("stroke")).toBe("var(--cx-border-strong)");
    expect(card("wait").dataset.phase).toBe("current");
    expect(card("wait").textContent).toContain("running");
  });
});
