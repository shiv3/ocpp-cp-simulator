// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import StepsGraphView from "../run/StepsGraphView";
import StepsView from "../run/StepsView";
import StepInspector from "./StepInspector";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  root = null;
  document.body.replaceChildren();
});

const node = (
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
) =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  }) as ScenarioNode;

const LONG = "in UnknownVendorWithAVeryLongName|AnotherLongVendorName";

function scenario(type: "switch" | "choice" = "switch"): ScenarioDefinition {
  const fork =
    type === "switch"
      ? node("route", ScenarioNodeType.SWITCH, {
          value: 1,
          cases: ["Accepted", LONG, "Rejected"],
        })
      : node("route", ScenarioNodeType.CHOICE, {
          options: [{ weight: 1, label: "x" }, { weight: 3 }],
        });
  const handles =
    type === "switch"
      ? ["case-0", "case-1", "case-2", "default"]
      : ["option-0", "option-1"];
  const nodes = [
    node("start", ScenarioNodeType.START),
    fork,
    ...handles.map((_, i) =>
      node(`s${i}`, ScenarioNodeType.DELAY, { delaySeconds: 1 }),
    ),
    node("end", ScenarioNodeType.END),
  ];
  return {
    id: "sw",
    name: "Switch",
    targetType: "connector",
    targetId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes,
    edges: [
      { id: "e-start", source: "start", target: "route" },
      ...handles.map((h, i) => ({
        id: `e-${i}`,
        source: "route",
        target: `s${i}`,
        sourceHandle: h,
      })),
      ...handles.map((_, i) => ({
        id: `e-end-${i}`,
        source: `s${i}`,
        target: "end",
      })),
    ],
  };
}

function Page({
  def,
  editable = true,
  readOnly = false,
  onRemoveLane,
  View = StepsGraphView,
}: {
  def: ScenarioDefinition;
  editable?: boolean;
  readOnly?: boolean;
  onRemoveLane?: (forkId: string, laneIndex: number) => void;
  View?: typeof StepsGraphView | typeof StepsView;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{
    nodeId: string;
    handle: string;
    nonce: number;
  } | null>(null);
  const node = def.nodes.find((n) => n.id === selected) ?? null;
  const inspector = (
    <StepInspector
      node={node}
      onChange={() => {}}
      scenario={def}
      focusLane={focus}
    />
  );
  return (
    <>
      <View
        tree={recognizeBlockTree(def)}
        editable={editable}
        selectedStepId={selected}
        onSelectStep={(id) => {
          setFocus(null);
          setSelected(id);
        }}
        onSelectLane={(nodeId, handle) => {
          setSelected(nodeId);
          setFocus((p) => ({ nodeId, handle, nonce: (p?.nonce ?? 0) + 1 }));
        }}
        onRemoveLane={onRemoveLane}
      />
      {readOnly ? <fieldset disabled>{inspector}</fieldset> : inspector}
    </>
  );
}

async function render(el: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
}

const tagButton = (name: string) =>
  document.body.querySelector<HTMLButtonElement>(
    `button[aria-label^="Edit ${name} of step"]`,
  )!;
const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("lane tags open the case in the inspector", () => {
  it("graph: clicking a case tag selects the switch and focuses that case", async () => {
    await render(<Page def={scenario()} />);
    expect(document.body.querySelector('[data-testid="step-inspector"]')).toBe(
      null,
    );
    await click(tagButton("case-1"));
    const row = document.body.querySelector<HTMLElement>(
      '[data-testid="switch-case-1"]',
    )!;
    expect(row.dataset.laneFocus).toBe("true");
    expect(row.contains(document.activeElement)).toBe(true);
    expect(
      document.body
        .querySelector('[data-testid="switch-case-0"]')
        ?.getAttribute("data-lane-focus"),
    ).toBeNull();
    // Asking for another lane moves the highlight.
    await click(tagButton("case-0"));
    expect(
      document.body
        .querySelector('[data-testid="switch-case-0"]')
        ?.getAttribute("data-lane-focus"),
    ).toBe("true");
  });

  it("the default tag opens the default note", async () => {
    await render(<Page def={scenario()} />);
    await click(tagButton("default"));
    const row = document.body.querySelector<HTMLElement>(
      '[data-testid="switch-default"]',
    )!;
    expect(row.dataset.laneFocus).toBe("true");
    expect(document.activeElement).toBe(row);
  });

  it("a choice option tag opens the option row", async () => {
    await render(<Page def={scenario("choice")} />);
    await click(tagButton("option-1"));
    const row = document.body.querySelector<HTMLElement>(
      '[data-testid="choice-option-1"]',
    )!;
    expect(row.dataset.laneFocus).toBe("true");
    expect(row.contains(document.activeElement)).toBe(true);
  });

  it("the tag names its step and carries the whole condition as tooltip", async () => {
    await render(<Page def={scenario()} />);
    const button = tagButton("case-1");
    expect(button.getAttribute("aria-label")).toMatch(
      /^Edit case-1 of step \d+$/,
    );
    expect(button.title).toContain(LONG);
  });

  it("the × still removes the lane and does not open it", async () => {
    const onRemoveLane = vi.fn();
    await render(<Page def={scenario()} onRemoveLane={onRemoveLane} />);
    const remove = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove branch B"]',
    )!;
    await click(remove);
    expect(onRemoveLane).toHaveBeenCalledWith("route", 1);
    expect(document.body.querySelector('[data-testid="step-inspector"]')).toBe(
      null,
    );
  });

  it("read-only: selects the switch and shows the case (focus on the row)", async () => {
    await render(<Page def={scenario()} editable={false} readOnly />);
    await click(tagButton("case-2"));
    const row = document.body.querySelector<HTMLElement>(
      '[data-testid="switch-case-2"]',
    )!;
    expect(row.dataset.laneFocus).toBe("true");
    expect(document.activeElement).toBe(row);
  });

  it("steps view: the lane header chip opens the case, × does not", async () => {
    const onRemoveLane = vi.fn();
    await render(
      <Page def={scenario()} View={StepsView} onRemoveLane={onRemoveLane} />,
    );
    await click(tagButton("case-1"));
    expect(
      document.body
        .querySelector('[data-testid="switch-case-1"]')
        ?.getAttribute("data-lane-focus"),
    ).toBe("true");
    expect(tagButton("case-1").title).toContain(LONG);
  });
});
