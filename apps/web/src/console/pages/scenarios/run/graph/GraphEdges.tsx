import React from "react";

import {
  END_R,
  START_R,
  type TreeGraphGeometry,
} from "../../../../lib/treeGraphLayout";
import { laneStyle, type BoxPhase } from "../stepVisuals";
import { LOOP_STROKE, TODO_STROKE } from "./graphShared";

export type EdgeIssueProps = {
  "data-issue": string;
  stroke: string;
  strokeWidth: number;
} | null;

const GraphEdges: React.FC<{
  geometry: TreeGraphGeometry;
  width: number;
  height: number;
  phaseOf: (id: string) => BoxPhase;
  edgeIssueProps: (edgeId: string | undefined) => EdgeIssueProps;
}> = ({ geometry, width, height, phaseOf, edgeIssueProps }) => {
  const { paths, ends } = geometry;
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      data-graph-edges=""
      className="pointer-events-none absolute inset-0"
    >
      <defs>
        <marker
          id="graph-link-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--cx-faint)" />
        </marker>
        <marker
          id="graph-loop-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill={LOOP_STROKE} />
        </marker>
      </defs>
      {geometry.loops.map((loop) => (
        <rect
          key={`rect:${loop.key}`}
          data-graph-loop={loop.headerId}
          x={loop.rect.x}
          y={loop.rect.y}
          width={loop.rect.w}
          height={loop.rect.h}
          rx={14}
          fill={LOOP_STROKE}
          fillOpacity={
            loop.ids.some((id) => phaseOf(id) === "current") ? 0.16 : 0.09
          }
        />
      ))}
      {paths.map((path) => (
        <path
          key={path.key}
          d={path.d}
          data-to={path.to}
          data-edge-id={path.edgeId}
          fill="none"
          strokeWidth={path.done ? 2 : 1.5}
          stroke={path.done ? laneStyle(path.lane).color : TODO_STROKE}
          {...edgeIssueProps(path.edgeId)}
        />
      ))}
      {geometry.loops.flatMap((loop) =>
        loop.arcs.map((arc) => (
          <path
            key={arc.key}
            d={arc.d}
            data-loop-arc={loop.headerId}
            data-edge-id={arc.edgeId}
            fill="none"
            strokeWidth={arc.done ? 2 : 1.75}
            stroke={LOOP_STROKE}
            markerEnd="url(#graph-loop-arrow)"
            {...edgeIssueProps(arc.edgeId)}
          />
        )),
      )}
      {geometry.links.map((link) => (
        <path
          key={link.key}
          d={link.d}
          data-link-from={link.from}
          data-link-to={link.to}
          data-link-role={link.role}
          fill="none"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          stroke={laneStyle(link.lane).color}
          strokeOpacity={link.role === "dead" ? 0.45 : 1}
          markerEnd="url(#graph-link-arrow)"
          data-edge-id={link.edgeId}
          {...edgeIssueProps(link.edgeId)}
        />
      ))}
      {geometry.merges.map((m) => (
        <circle
          key={`merge:${m.x}:${m.y}`}
          data-graph-merge=""
          cx={m.x}
          cy={m.y}
          r={3.5}
          fill="var(--cx-faint)"
        />
      ))}
      {geometry.start && (
        <circle
          data-graph-start=""
          cx={geometry.start.x}
          cy={geometry.start.y}
          r={START_R}
          fill="var(--cx-faint)"
        />
      )}
      {ends.map((end) => (
        <circle
          key={`end:${end.x}:${end.y}`}
          data-graph-end=""
          cx={end.x}
          cy={end.y}
          r={END_R}
          fill="var(--cx-card)"
          stroke="var(--cx-faint)"
          strokeWidth={2}
        />
      ))}
    </svg>
  );
};

export default GraphEdges;
