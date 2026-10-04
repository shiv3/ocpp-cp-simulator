import React from "react";

import { curveDurationMin, curvePeakKw, type PowerPoint } from "./powerCurve";
import type { PowerSample } from "./useConnectorPower";

export interface PowerSparklineProps {
  /** Meter readings of the transaction, oldest first. */
  samples: PowerSample[];
  /** When the transaction started (ms), else the first reading's time. */
  startedAt: number | null;
  now: number;
  /** The EV's max power: the top grid line. */
  maxKw: number;
  /** Power now (slope of the last two readings). */
  powerKw: number;
  /** The configured auto meter curve, drawn as a dotted ghost. */
  ghost: PowerPoint[];
}

const W = 600;
const H = 76;
const TOP = 16;
const BASE = H - 16;
const X0 = 10;
const X1 = W - 10;

const formatKw = (kw: number) => String(Number(kw.toFixed(1)));

/**
 * Power this session: the readings' power as a line over a 14 % area, the
 * EV's max power as the top grid line, the configured auto meter curve as a
 * dotted ghost on the same time axis, and a dot at the latest reading.
 */
const PowerSparkline: React.FC<PowerSparklineProps> = ({
  samples,
  startedAt,
  now,
  maxKw,
  powerKw,
  ghost,
}) => {
  const head = (right: string) => (
    <div className="flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
      <span>Power this session</span>
      <b className="font-mono text-[11.5px] font-medium normal-case tracking-normal text-cx-muted">
        {right}
      </b>
    </div>
  );

  // Power between consecutive readings, placed at the later one.
  const powers = samples.slice(1).map((s, i) => {
    const prev = samples[i];
    const ms = s.t - prev.t;
    return {
      t: s.t,
      kw: ms > 0 ? Math.max(0, ((s.wh - prev.wh) / ms) * 3600) : 0,
    };
  });

  const t0 = startedAt ?? samples[0]?.t ?? now;
  const ghostMs = curveDurationMin(ghost) * 60_000;
  const span = Math.max(now - t0, ghostMs, 1);
  const yMax = Math.max(
    maxKw,
    curvePeakKw(ghost),
    ...powers.map((p) => p.kw),
    0.1,
  );
  const x = (t: number) => X0 + ((t - t0) / span) * (X1 - X0);
  const y = (kw: number) => BASE - (kw / yMax) * (BASE - TOP);

  const axis = (
    <>
      <line className="stroke-cx-border" x1={X0} y1={BASE} x2={X1} y2={BASE} />
      <line
        className="stroke-cx-border"
        x1={X0}
        y1={y(maxKw)}
        x2={X1}
        y2={y(maxKw)}
      />
      <text
        className="fill-cx-faint font-mono text-[10.5px]"
        x={X0}
        y={y(maxKw) - 5}
      >
        {formatKw(maxKw)} kW
      </text>
      <text className="fill-cx-faint font-mono text-[10.5px]" x={X0} y={H - 2}>
        start
      </text>
    </>
  );

  if (samples.length === 0) {
    return (
      <div data-testid="power-sparkline" className="col-span-full">
        {head("no transaction")}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          aria-hidden
          className="mt-1 block h-[76px] w-full"
        >
          {axis}
        </svg>
      </div>
    );
  }

  const pts = powers.map((p) => [x(p.t), y(p.kw)] as const);
  const line = pts
    .map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`)
    .join(" ");
  const area =
    pts.length > 1
      ? `${line} L${pts[pts.length - 1][0]} ${BASE} L${pts[0][0]} ${BASE} Z`
      : "";
  const ghostPath = ghost
    .map((p, i) => `${i ? "L" : "M"}${x(t0 + p.minute * 60_000)} ${y(p.kw)}`)
    .join(" ");
  const nowX = x(now);
  const last = pts[pts.length - 1];

  return (
    <div data-testid="power-sparkline" className="col-span-full">
      {head(`${powerKw.toFixed(1)} kW now · max ${formatKw(maxKw)} kW`)}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Power this session, ${powerKw.toFixed(1)} kW now`}
        className="mt-1 block h-[76px] w-full"
      >
        {axis}
        <text
          className="fill-cx-faint font-mono text-[10.5px]"
          x={nowX}
          y={H - 2}
          textAnchor={nowX > X1 - 40 ? "end" : "middle"}
        >
          now
        </text>
        {ghostPath && (
          <path
            data-testid="power-ghost"
            className="fill-none stroke-cx-border-strong"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            d={ghostPath}
          />
        )}
        {area && <path className="fill-cx-accent opacity-[0.14]" d={area} />}
        {line && (
          <path
            className="fill-none stroke-cx-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            d={line}
          />
        )}
        {last && (
          <circle
            className="fill-cx-accent stroke-cx-card"
            strokeWidth={2}
            cx={last[0]}
            cy={last[1]}
            r={4}
          />
        )}
      </svg>
    </div>
  );
};

export default PowerSparkline;
