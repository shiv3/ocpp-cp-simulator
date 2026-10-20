// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { deriveStepLayout } from "../../../lib/stepLayout";
import { forkScenario } from "../../../test/scenarioFixtures";
import StepsView, { type StepRunViewProps } from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;

async function render(props: Omit<StepRunViewProps, "layout">) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsView layout={deriveStepLayout(forkScenario())} {...props} />,
    );
  });
}

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
});
