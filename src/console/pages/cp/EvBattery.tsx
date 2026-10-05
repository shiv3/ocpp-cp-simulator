import React, { useState } from "react";

import { cn } from "@/lib/utils";

import type { BatteryTone } from "./connectorCardModel";

export interface EvBatteryProps {
  /** Live SoC in %, null when the connector reports none. */
  soc: number | null;
  targetSoc: number;
  capacityKwh: number;
  /** Current charging power, for the time to target. */
  powerKw: number;
  evName: string;
  tone: BatteryTone;
  /** A dragged SoC, once the pointer (or key) is released. */
  onSocCommit: (soc: number) => void;
  disabled?: boolean;
}

const FILL: Record<BatteryTone, string> = {
  charging: "fill-cx-accent",
  idle: "fill-cx-fg2",
  full: "fill-cx-emerald",
  faulted: "fill-cx-rose",
};

// The mock's geometry: a 120×56 case at (2, 2) with a 5 px inset track.
const CASE = { x: 2, y: 2, w: 120, h: 56 };
const PAD = 5;
const INNER = CASE.w - PAD * 2;

function formatSocValue(soc: number): string {
  return Number.isInteger(soc) ? String(soc) : soc.toFixed(1);
}

/** "3 h 27 min" from 207 minutes, "45 min" under an hour. */
function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

/**
 * The EV as a battery: an SVG case with a fill by SoC (coloured by state, a
 * bolt while charging) and a dashed line at the target SoC, the SoC as the hero
 * figure, and under it the target, a straight-line time to it at the current
 * power, and the vehicle. A transparent range input over the battery lets the
 * operator drag the SoC; it is sent on release.
 */
const EvBattery: React.FC<EvBatteryProps> = ({
  soc,
  targetSoc,
  capacityKwh,
  powerKw,
  evName,
  tone,
  onSocCommit,
  disabled,
}) => {
  // The dragged value, shown at once and sent on release.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? soc;
  const fillWidth = shown == null ? 0 : Math.round((INNER * shown) / 100);
  const targetX = CASE.x + PAD + (INNER * targetSoc) / 100;

  const commit = () => {
    if (draft == null) return;
    setDraft(null);
    if (draft !== soc) onSocCommit(draft);
  };

  let detail: React.ReactNode;
  if (shown == null) {
    detail = (
      <>
        SoC not reported · <b className="font-medium text-cx-fg2">{evName}</b>,{" "}
        {capacityKwh} kWh
      </>
    );
  } else if (shown >= targetSoc) {
    detail = (
      <>
        Target <b className="font-medium text-cx-fg2">{targetSoc} %</b> reached
        · {evName}
      </>
    );
  } else {
    const toGo =
      powerKw > 0
        ? ((((targetSoc - shown) / 100) * capacityKwh) / powerKw) * 60
        : null;
    detail = (
      <>
        Target <b className="font-medium text-cx-fg2">{targetSoc} %</b>
        {toGo != null && (
          <>
            {" "}
            · about{" "}
            <b className="font-medium text-cx-fg2">
              {formatDuration(toGo)}
            </b> at {powerKw.toFixed(1)} kW
          </>
        )}{" "}
        · {evName}
      </>
    );
  }

  return (
    <div className="relative flex items-center gap-4 @max-[560px]:flex-col @max-[560px]:items-start @max-[560px]:gap-2">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(shown ?? 0)}
        disabled={disabled}
        aria-label="State of charge (drag)"
        title="Drag to set the SoC"
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="peer absolute left-[7px] top-2 m-0 h-12 w-28 cursor-ew-resize opacity-0 disabled:cursor-default"
      />
      <svg
        viewBox="0 0 136 60"
        aria-hidden
        className="h-auto w-[150px] max-w-full flex-none rounded-lg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-cx-accent"
      >
        <rect
          className="fill-cx-sub"
          x={CASE.x + PAD}
          y={CASE.y + PAD}
          width={INNER}
          height={CASE.h - PAD * 2}
          rx={4}
        />
        <rect
          data-testid="battery-fill"
          className={cn(
            FILL[tone],
            tone === "charging" && "motion-safe:animate-pulse",
          )}
          x={CASE.x + PAD}
          y={CASE.y + PAD}
          width={fillWidth}
          height={CASE.h - PAD * 2}
          rx={4}
        />
        <rect
          className="fill-none stroke-cx-border-strong"
          strokeWidth={2}
          x={CASE.x}
          y={CASE.y}
          width={CASE.w}
          height={CASE.h}
          rx={8}
        />
        <rect
          className="fill-cx-border-strong"
          x={CASE.x + CASE.w + 2}
          y={CASE.y + CASE.h / 2 - 9}
          width={6}
          height={18}
          rx={2}
        />
        <line
          data-testid="battery-target"
          className="stroke-cx-fg2"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          x1={targetX}
          y1={CASE.y - 1}
          x2={targetX}
          y2={CASE.y + CASE.h + 1}
        />
        {tone === "charging" && (
          <path
            data-testid="battery-bolt"
            className="fill-white"
            transform={`translate(${CASE.x + PAD + Math.max(18, fillWidth / 2) - 7},${CASE.y + 14}) scale(1.3)`}
            d="M8 0 2 12h5l-1 10 7-13H8z"
          />
        )}
      </svg>
      <div className="min-w-0">
        <div
          data-testid="soc-hero"
          className="whitespace-nowrap text-[36px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-cx-fg"
        >
          {shown == null ? (
            "—"
          ) : (
            <>
              {formatSocValue(shown)}
              <small className="ml-0.5 text-lg font-medium text-cx-muted">
                %
              </small>
            </>
          )}
        </div>
        <div className="mt-1.5 break-words text-[12.5px] text-cx-muted">
          {detail}
        </div>
      </div>
    </div>
  );
};

export default EvBattery;
