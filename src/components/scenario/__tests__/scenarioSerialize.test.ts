import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { ScenarioNodeType } from "../../../cp/application/scenario/ScenarioTypes";
import {
  deserializeScenarioGraph,
  serializeScenarioGraph,
} from "../scenarioSerialize";

describe("scenario graph serializer", () => {
  it("strips runtime overlays while preserving scenario graph data", () => {
    const nodes = [
      {
        id: "meter-1",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 120, y: 240 },
        data: {
          label: "Meter value",
          value: 1500,
          sendMessage: true,
          progress: { remaining: 1, total: 5 },
          currentValue: 3000,
          style: { border: "3px solid #10b981" },
          className: "executing-node",
        },
        selected: true,
        dragging: true,
        style: { border: "3px solid #10b981" },
        className: "executing-node",
        width: 180,
        height: 90,
        measured: { width: 180, height: 90 },
        positionAbsolute: { x: 120, y: 240 },
      },
    ] as unknown as Node[];
    const edges = [
      {
        id: "edge-1",
        source: "start",
        target: "meter-1",
        selected: true,
        style: { stroke: "#10b981" },
      },
    ] as unknown as Edge[];

    const serialized = serializeScenarioGraph(nodes, edges);

    expect(serialized.nodes[0]).toEqual({
      id: "meter-1",
      type: ScenarioNodeType.METER_VALUE,
      position: { x: 120, y: 240 },
      data: {
        label: "Meter value",
        value: 1500,
        sendMessage: true,
      },
    });
    expect(serialized.nodes[0]).not.toHaveProperty("selected");
    expect(serialized.nodes[0]).not.toHaveProperty("dragging");
    expect(serialized.nodes[0]).not.toHaveProperty("style");
    expect(serialized.nodes[0]).not.toHaveProperty("className");
    expect(serialized.nodes[0]).not.toHaveProperty("width");
    expect(serialized.nodes[0]).not.toHaveProperty("height");
    expect(serialized.nodes[0]).not.toHaveProperty("measured");
    expect(serialized.nodes[0]).not.toHaveProperty("positionAbsolute");
    expect(serialized.nodes[0].data).not.toHaveProperty("progress");
    expect(serialized.nodes[0].data).not.toHaveProperty("currentValue");
    expect(serialized.nodes[0].data).not.toHaveProperty("style");
    expect(serialized.nodes[0].data).not.toHaveProperty("className");
    expect(serialized.edges[0]).toEqual({
      id: "edge-1",
      source: "start",
      target: "meter-1",
    });
    expect(serialized.nodes[0]).not.toBe(nodes[0]);
    expect(serialized.nodes[0].position).not.toBe(nodes[0].position);
  });

  it("round-trips deserialized graphs back to the same persisted shape", () => {
    const serialized = serializeScenarioGraph(
      [
        {
          id: "status-1",
          type: ScenarioNodeType.STATUS_CHANGE,
          position: { x: 10, y: 20 },
          data: { label: "Available", status: "Available" },
        },
      ],
      [{ id: "edge-1", source: "start", target: "status-1" } as Edge],
    );

    const deserialized = deserializeScenarioGraph(
      serialized.nodes,
      serialized.edges,
    );

    expect(
      serializeScenarioGraph(deserialized.nodes, deserialized.edges),
    ).toEqual(serialized);
    expect(deserialized.nodes[0]).not.toBe(serialized.nodes[0]);
    expect(deserialized.edges[0]).not.toBe(serialized.edges[0]);
  });
});
