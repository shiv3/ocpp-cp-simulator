import React from "react";

import type { DcCurvePoint } from "@/cp/domain/vehicle/VehicleProfile";

/** A small power-against-SoC drawing of a DC curve, as published. */
const CurvePreview: React.FC<{
  points: readonly DcCurvePoint[];
  width?: number;
  height?: number;
}> = ({ points, width = 120, height = 36 }) => {
  if (points.length === 0) return null;
  const peak = Math.max(...points.map((p) => p.powerKw)) || 1;
  const coords = [...points]
    .sort((a, b) => a.socPercent - b.socPercent)
    .map(
      (p) =>
        `${((p.socPercent / 100) * width).toFixed(1)},${(
          height -
          (p.powerKw / peak) * (height - 2) -
          1
        ).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Curve preview"
      className="shrink-0 rounded border border-cx-border bg-cx-card"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="text-cx-accent"
      />
    </svg>
  );
};

export default CurvePreview;
