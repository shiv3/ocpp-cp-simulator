// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { updateStepData } from "../../../lib/scenarioSteps";
import StepInspector from "./StepInspector";

let root: Root | null = null;
let current: ScenarioDefinition | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  root = null;
  current = null;
  document.body.replaceChildren();
});

function node(
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as ScenarioNode;
}

/** START → route (switch, cases "a" / "b") ┬ case-0 → stepA → END
 *                                          ├ case-1 → stepB → END
 *                                          └ default → END */
function switchScenario(): ScenarioDefinition {
  return {
    id: "sw",
    name: "Switch",
    targetType: "connector",
    targetId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      node("start", ScenarioNodeType.START),
      node("route", ScenarioNodeType.SWITCH, {
        value: { $from: "state.mode" },
        cases: ["a", "b"],
      }),
      node("stepA", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepB", ScenarioNodeType.DELAY, { delaySeconds: 2 }),
      node("store", ScenarioNodeType.SET_STATE, { key: "mode", value: "a" }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "store" },
      { id: "e-store", source: "store", target: "route" },
      { id: "e-a", source: "route", target: "stepA", sourceHandle: "case-0" },
      { id: "e-b", source: "route", target: "stepB", sourceHandle: "case-1" },
      { id: "e-d", source: "route", target: "end", sourceHandle: "default" },
      { id: "e-a-end", source: "stepA", target: "end" },
      { id: "e-b-end", source: "stepB", target: "end" },
    ],
  };
}

function choiceScenario(): ScenarioDefinition {
  return {
    ...switchScenario(),
    nodes: [
      node("start", ScenarioNodeType.START),
      node("route", ScenarioNodeType.CHOICE, {
        options: [{ weight: 1, label: "x" }, { weight: 3 }],
      }),
      node("stepA", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepB", ScenarioNodeType.DELAY, { delaySeconds: 2 }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "route" },
      { id: "e-a", source: "route", target: "stepA", sourceHandle: "option-0" },
      { id: "e-b", source: "route", target: "stepB", sourceHandle: "option-1" },
      { id: "e-a-end", source: "stepA", target: "end" },
      { id: "e-b-end", source: "stepB", target: "end" },
    ],
  };
}

function Editor({ initial }: { initial: ScenarioDefinition }) {
  const [def, setDef] = useState(initial);
  current = def;
  const selected = def.nodes.find((n) => n.id === "route")!;
  return (
    <StepInspector
      node={selected}
      onChange={(data) => setDef(updateStepData(def, "route", data))}
      scenario={def}
      onScenarioChange={setDef}
    />
  );
}

async function render(element: React.ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

async function clickLabel(label: string): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

async function clickText(text: string): Promise<void> {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button ${text}`);
  await act(async () => button.click());
}

const lane = (handle: string) =>
  document.body.querySelector(`[data-testid="lane-${handle}"]`)?.textContent;

const handleIssues = (def: ScenarioDefinition) =>
  validateScenarioGraph(def).filter(
    (i) => i.code === "unpickableHandle" || i.code === "duplicateHandle",
  );

describe("StepInspector: switch", () => {
  it("lists the cases with their lanes and the default lane", async () => {
    await render(<Editor initial={switchScenario()} />);
    expect(lane("case-0")).toMatch(/stepA/);
    expect(lane("case-1")).toMatch(/stepB/);
    expect(lane("default")).toMatch(/End of scenario/);
    // The value reads from state; its key comes from the setState step.
    expect(
      document.body.querySelector<HTMLInputElement>(
        '[aria-label="Path of Value"]',
      )?.value,
    ).toBe("mode");
  });

  it("reorders a case and moves its lane with it", async () => {
    await render(<Editor initial={switchScenario()} />);
    await clickLabel("Move case-1 up");
    const data = current!.nodes.find((n) => n.id === "route")!.data as {
      cases: unknown[];
    };
    expect(data.cases).toEqual(["b", "a"]);
    expect(current!.edges.find((e) => e.id === "e-b")!.sourceHandle).toBe(
      "case-0",
    );
    expect(current!.edges.find((e) => e.id === "e-a")!.sourceHandle).toBe(
      "case-1",
    );
    expect(lane("case-0")).toMatch(/stepB/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("asks before removing a case that has a lane", async () => {
    await render(<Editor initial={switchScenario()} />);
    const before = current!;
    await clickLabel("Remove case-0");
    const question = document.body.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toMatch(/case-0 leads to/);
    expect(current).toBe(before);

    await clickText("Keep");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(current).toBe(before);

    await clickLabel("Remove case-0");
    await clickText("Remove with its edge");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-a");
    expect(current!.edges.find((e) => e.id === "e-b")!.sourceHandle).toBe(
      "case-0",
    );
    expect(lane("case-0")).toMatch(/stepB/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("removes a case without a lane at once, and warns on a duplicate", async () => {
    await render(<Editor initial={switchScenario()} />);
    await clickText("Add case");
    expect(lane("case-2")).toMatch(/no step yet/);
    await clickLabel("Remove case-2");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(
      (
        current!.nodes.find((n) => n.id === "route")!.data as unknown as {
          cases: unknown[];
        }
      ).cases,
    ).toEqual(["a", "b"]);

    await clickText("Add case");
    await clickText("Add case");
    expect(document.body.textContent).toMatch(/Same value as case-2/);
  });
});

describe("StepInspector: choice", () => {
  it("shows each option's share and moves lanes with options", async () => {
    await render(<Editor initial={choiceScenario()} />);
    expect(
      document.body.querySelector('[data-testid="choice-share-0"]')
        ?.textContent,
    ).toBe("25%");
    expect(
      document.body.querySelector('[data-testid="choice-share-1"]')
        ?.textContent,
    ).toBe("75%");
    await clickLabel("Move option-0 down");
    expect(current!.edges.find((e) => e.id === "e-a")!.sourceHandle).toBe(
      "option-1",
    );
    expect(lane("option-1")).toMatch(/stepA/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("warns under two options after a confirmed removal", async () => {
    await render(<Editor initial={choiceScenario()} />);
    await clickLabel("Remove option-1");
    await clickText("Remove with its edge");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-b");
    expect(document.body.textContent).toMatch(/Fewer than two options/);
  });
});

describe("StepInspector: read-only", () => {
  it("renders the switch inspector disabled, with its lanes", async () => {
    const def = switchScenario();
    await render(
      <fieldset disabled>
        <StepInspector
          node={def.nodes[1]!}
          onChange={() => undefined}
          scenario={def}
        />
      </fieldset>,
    );
    expect(lane("case-1")).toMatch(/stepB/);
    expect(
      document.body.querySelector('[data-testid="switch-case-0"]'),
    ).not.toBeNull();
  });
});
