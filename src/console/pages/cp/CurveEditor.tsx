import React, { useRef, useState } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS } from "../../components/filterStyles";
import { CURVE_VIEW, curveScale } from "./connectorCardModel";
import {
  curveDurationMin,
  curveEnergyKwh,
  curvePeakKw,
  formatMinutes,
  type PowerPoint,
} from "./powerCurve";

export interface CurveEditorProps {
  points: PowerPoint[];
  onChange: (points: PowerPoint[]) => void;
  /** The EV's max power: the dashed cap line and the drag ceiling. */
  capKw: number;
  /** For the summary: MeterValues at this interval, % of this battery. */
  intervalSeconds: number;
  capacityKwh: number;
}

/** The last minute a point may sit at (24 h). */
const MAX_MINUTE = 1440;

/** 15 → "15", 7.5 → "7.5". */
const formatNumber = (value: number) => formatMinutes(Number(value.toFixed(1)));

const roundTo = (value: number, step: number) =>
  Number((Math.round(value / step) * step).toFixed(3));
const clamp = (value: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, value));

/** A table cell that commits on blur or Enter, so typing a number digit by
 *  digit is not clamped half-way. */
const NumberCell: React.FC<{
  label: string;
  value: number;
  onCommit: (value: number) => number;
}> = ({ label, value, onCommit }) => (
  <input
    key={value}
    type="number"
    inputMode="decimal"
    aria-label={label}
    defaultValue={value}
    onBlur={(e) => {
      const next = Number(e.currentTarget.value);
      if (e.currentTarget.value.trim() === "" || !Number.isFinite(next)) {
        e.currentTarget.value = String(value);
        return;
      }
      e.currentTarget.value = String(onCommit(next));
    }}
    onKeyDown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
    }}
    className={cn(FILTER_INPUT_CLASS, "w-20 py-0.5 font-mono tabular-nums")}
  />
);

/**
 * Power (kW) over the session (minutes), piecewise linear: drag a point in the
 * chart (pointer events, kept between its neighbours and under the EV's max
 * power, shown as a dashed red line) or edit it in the table under it; add and
 * remove points; the summary line sums the curve up.
 */
const CurveEditor: React.FC<CurveEditorProps> = ({
  points,
  onChange,
  capKw,
  intervalSeconds,
  capacityKwh,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  // While dragging, the axes stay as they were at pointerdown, or the point
  // would run away as the scale follows it.
  const [drag, setDrag] = useState<{
    index: number;
    xMax: number;
    yMax: number;
  } | null>(null);

  const live = curveScale(points, capKw);
  const { xMax, yMax } = drag ?? live;
  const {
    width: W,
    height: H,
    left: L,
    right: R,
    top: T,
    bottom: B,
  } = CURVE_VIEW;
  const cx = (minute: number) => L + (minute / xMax) * (W - L - R);
  const cy = (kw: number) => T + (1 - kw / yMax) * (H - T - B);

  const bounds = (index: number) => ({
    lo: index > 0 ? points[index - 1].minute : 0,
    hi: index < points.length - 1 ? points[index + 1].minute : MAX_MINUTE,
  });

  const replace = (index: number, point: PowerPoint) =>
    onChange(points.map((p, i) => (i === index ? point : p)));

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!drag || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) * W) / rect.width;
    const y = ((event.clientY - rect.top) * H) / rect.height;
    const { lo, hi } = bounds(drag.index);
    const minute = Math.round(((x - L) / (W - L - R)) * drag.xMax);
    const kw = roundTo((1 - (y - T) / (H - T - B)) * drag.yMax, 0.1);
    replace(drag.index, {
      minute: clamp(minute, lo, Math.min(hi, drag.xMax)),
      kw: clamp(kw, 0, capKw),
    });
  };

  const endDrag = () => setDrag(null);

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${cx(p.minute)} ${cy(p.kw)}`)
    .join(" ");
  const area =
    points.length > 1
      ? `${line} L${cx(points[points.length - 1].minute)} ${cy(0)} L${cx(points[0].minute)} ${cy(0)} Z`
      : "";

  const duration = curveDurationMin(points);
  const energy = curveEnergyKwh(points);
  const meterValues =
    intervalSeconds > 0 ? Math.ceil((duration * 60) / intervalSeconds) : 0;

  const addPoint = () => {
    if (points.length < 2) return;
    const a = points[points.length - 2];
    const z = points[points.length - 1];
    const added = {
      minute: Math.round((a.minute + z.minute) / 2),
      kw: roundTo((a.kw + z.kw) / 2, 0.1),
    };
    onChange([...points.slice(0, -1), added, z]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[9px] border border-cx-border bg-cx-card px-2 pb-1 pt-2">
        <svg
          ref={svgRef}
          data-testid="curve-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Power over the session"
          className="block h-auto w-full touch-none"
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {[0, 1, 2, 3].map((k) => {
            const kw = (yMax / 3) * k;
            return (
              <g key={`y${k}`}>
                <line
                  className="stroke-cx-border"
                  x1={L}
                  x2={W - R}
                  y1={cy(kw)}
                  y2={cy(kw)}
                />
                <text
                  className="fill-cx-faint font-mono text-[10.5px]"
                  x={L - 6}
                  y={cy(kw) + 3.5}
                  textAnchor="end"
                >
                  {formatNumber(kw)} kW
                </text>
              </g>
            );
          })}
          {[0, 1, 2, 3, 4].map((k) => {
            const minute = (xMax / 4) * k;
            return (
              <text
                key={`x${k}`}
                className="fill-cx-faint font-mono text-[10.5px]"
                x={cx(minute)}
                y={H - 10}
                textAnchor="middle"
              >
                {formatNumber(minute)} min
              </text>
            );
          })}
          <line
            data-testid="curve-cap"
            className="stroke-cx-rose"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            x1={L}
            x2={W - R}
            y1={cy(capKw)}
            y2={cy(capKw)}
          />
          <text
            className="fill-cx-rose font-mono text-[11px]"
            x={W - R}
            y={cy(capKw) - 5}
            textAnchor="end"
          >
            EV max {formatNumber(capKw)} kW
          </text>
          {area && <path className="fill-cx-accent opacity-[0.12]" d={area} />}
          <path
            className="fill-none stroke-cx-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            d={line}
          />
          {points.map((p, i) => (
            <circle
              key={i}
              data-point-index={i}
              className={cn(
                "cursor-grab fill-cx-card stroke-cx-accent hover:fill-cx-accent",
                drag?.index === i && "fill-cx-accent",
              )}
              strokeWidth={2}
              cx={cx(p.minute)}
              cy={cy(p.kw)}
              r={7}
              onPointerDown={(event) => {
                event.preventDefault();
                (event.currentTarget as Element).setPointerCapture?.(
                  event.pointerId,
                );
                setDrag({ index: i, ...live });
              }}
            >
              <title>
                {formatMinutes(p.minute)} min · {p.kw} kW
              </title>
            </circle>
          ))}
        </svg>
      </div>

      <div
        data-testid="curve-summary"
        className="flex flex-wrap gap-x-[18px] gap-y-2 text-[12.5px] text-cx-muted"
      >
        <span>
          Duration{" "}
          <b className="font-medium text-cx-fg2">
            {formatMinutes(duration)} min
          </b>
        </span>
        <span>
          Energy over the curve{" "}
          <b className="font-medium text-cx-fg2">{energy.toFixed(1)} kWh</b>
          {capacityKwh > 0 &&
            ` (${Math.round((energy / capacityKwh) * 100)} % of the battery)`}
        </span>
        <span>
          Peak{" "}
          <b className="font-medium text-cx-fg2">
            {curvePeakKw(points).toFixed(1)} kW
          </b>
        </span>
        {meterValues > 0 && (
          <span>
            {meterValues} MeterValues at {intervalSeconds} s
          </span>
        )}
      </div>

      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {["Point", "Minute", "kW", ""].map((h, i) => (
              <th
                key={i}
                className="px-2 py-1 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-cx-faint"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i} data-point-row className="border-t border-cx-border">
              <td className="px-2 py-[3px] font-mono text-cx-muted">{i + 1}</td>
              <td className="px-2 py-[3px]">
                <NumberCell
                  label={`Point ${i + 1} minute`}
                  value={p.minute}
                  onCommit={(value) => {
                    const { lo, hi } = bounds(i);
                    const minute = clamp(roundTo(value, 0.1), lo, hi);
                    replace(i, { ...p, minute });
                    return minute;
                  }}
                />
              </td>
              <td className="px-2 py-[3px]">
                <NumberCell
                  label={`Point ${i + 1} kW`}
                  value={p.kw}
                  onCommit={(value) => {
                    const kw = clamp(roundTo(value, 0.1), 0, capKw);
                    replace(i, { ...p, kw });
                    return kw;
                  }}
                />
              </td>
              <td className="px-2 py-[3px] text-right">
                {points.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove point ${i + 1}`}
                    onClick={() => onChange(points.filter((_, j) => j !== i))}
                    className="rounded-md p-1 text-cx-faint hover:bg-cx-sub hover:text-cx-rose"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          ))}
          <tr className="border-t border-cx-border">
            <td colSpan={4} className="px-2 py-1.5">
              <button
                type="button"
                onClick={addPoint}
                className="text-[12.5px] text-cx-accent hover:underline"
              >
                + Add point
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default CurveEditor;
