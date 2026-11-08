// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import StepTile from "./StepTile";

let root: Root | null = null;

async function tileIcon(type: ScenarioNodeType): Promise<SVGElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const node = {
    id: "n1",
    type,
    position: { x: 0, y: 0 },
    data: {},
  } as unknown as ScenarioNode;
  await act(async () => {
    root!.render(<StepTile node={node} />);
  });
  return container.querySelector("svg")!;
}

describe("StepTile", () => {
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

  it.each([
    [ScenarioNodeType.TRANSACTION, "evicon-charging-session"],
    [ScenarioNodeType.UNLOCK_OUTCOME, "evicon-charging-session"],
    [ScenarioNodeType.METER_VALUE, "evicon-car-plugged"],
    [ScenarioNodeType.CONNECTOR_PLUG, "evicon-car-plugged"],
  ])("a %s step shows the EV-domain icon %s", async (type, iconClass) => {
    const icon = await tileIcon(type);
    expect(icon.classList).toContain(iconClass);
  });

  it.each([
    [ScenarioNodeType.STATUS_CHANGE, "lucide-circle-dot"],
    [ScenarioNodeType.DELAY, "lucide-hourglass"],
    [ScenarioNodeType.DATA_TRANSFER, "lucide-wrench"],
  ])("a %s step keeps its generic Lucide icon %s", async (type, iconClass) => {
    const icon = await tileIcon(type);
    expect(icon.classList).toContain(iconClass);
  });
});
