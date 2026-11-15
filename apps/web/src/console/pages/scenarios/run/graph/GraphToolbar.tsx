import React from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { ZOOM_STEP, clampZoom } from "../../../../lib/graphZoom";

const zoomButton =
  "flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs text-cx-fg2 hover:bg-cx-sub disabled:cursor-not-allowed disabled:opacity-40";

const GraphToolbar: React.FC<{
  zoom: number;
  zoomMode: "fit" | number;
  setZoomMode: (mode: "fit" | number) => void;
}> = ({ zoom, zoomMode, setZoomMode }) => {
  const { t } = useTranslation();
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  return (
    <div
      role="toolbar"
      aria-label={t("scenarioRun.zoom.label")}
      className="mb-1.5 flex items-center justify-end gap-0.5"
    >
      <button
        type="button"
        aria-label={t("scenarioRun.zoom.out")}
        title={t("scenarioRun.zoom.out")}
        disabled={zoom <= 0.25}
        onClick={() => setZoomMode(clampZoom(zoom / ZOOM_STEP))}
        className={zoomButton}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span
        data-testid="graph-zoom-level"
        aria-live="polite"
        className="w-10 text-center font-mono text-[11px] text-cx-muted"
      >
        {zoomLabel}
      </span>
      <button
        type="button"
        aria-label={t("scenarioRun.zoom.in")}
        title={t("scenarioRun.zoom.in")}
        disabled={zoom >= 2}
        onClick={() => setZoomMode(clampZoom(zoom * ZOOM_STEP))}
        className={zoomButton}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-pressed={zoomMode === "fit"}
        title={t("scenarioRun.zoom.fitHint")}
        onClick={() => setZoomMode("fit")}
        className={cn(zoomButton, zoomMode === "fit" && "bg-cx-sub")}
      >
        <Maximize2 className="mr-1 h-3 w-3" aria-hidden />
        {t("scenarioRun.zoom.fit")}
      </button>
      <button
        type="button"
        aria-pressed={zoomMode === 1}
        title={t("scenarioRun.zoom.resetHint")}
        onClick={() => setZoomMode(1)}
        className={cn(zoomButton, zoomMode === 1 && "bg-cx-sub")}
      >
        100%
      </button>
    </div>
  );
};

export default GraphToolbar;
