import React, { useState, useEffect, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Save, X, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AutoMeterValueConfig,
  CurvePoint,
  calculateBezierPoint,
} from "../cp/domain/connector/MeterValueCurve";

interface MeterValueCurveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: AutoMeterValueConfig) => void;
  initialConfig: AutoMeterValueConfig;
}

const MeterValueCurveModal: React.FC<MeterValueCurveModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialConfig,
}) => {
  const [config, setConfig] = useState<AutoMeterValueConfig>(initialConfig);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(
    null
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Canvas dimensions
  const CANVAS_WIDTH = 800;
  const CANVAS_HEIGHT = 400;
  const PADDING = 40;
  const GRAPH_WIDTH = CANVAS_WIDTH - 2 * PADDING;
  const GRAPH_HEIGHT = CANVAS_HEIGHT - 2 * PADDING;

  // Axis ranges
  const [maxTime, setMaxTime] = useState(60); // minutes
  const [maxValue, setMaxValue] = useState(100); // kWh

  useEffect(() => {
    setConfig(initialConfig);
  }, [initialConfig, isOpen]);

  useEffect(() => {
    if (isOpen) {
      drawCanvas();
    }
  }, [config, isOpen, maxTime, maxValue]);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Set up styles
    ctx.strokeStyle = "#e5e7eb"; // gray-200
    ctx.fillStyle = "#374151"; // gray-700
    ctx.font = "12px sans-serif";

    // Draw grid
    drawGrid(ctx);

    // Draw axes
    drawAxes(ctx);

    // Draw curve
    if (config.curvePoints.length > 0) {
      drawCurve(ctx);
    }

    // Draw control points
    drawControlPoints(ctx);
  };

  const drawGrid = (ctx: CanvasRenderingContext2D) => {
    ctx.strokeStyle = "#f3f4f6"; // gray-100

    // Vertical grid lines (time)
    for (let i = 0; i <= 10; i++) {
      const x = PADDING + (GRAPH_WIDTH * i) / 10;
      ctx.beginPath();
      ctx.moveTo(x, PADDING);
      ctx.lineTo(x, PADDING + GRAPH_HEIGHT);
      ctx.stroke();
    }

    // Horizontal grid lines (value)
    for (let i = 0; i <= 10; i++) {
      const y = PADDING + (GRAPH_HEIGHT * i) / 10;
      ctx.beginPath();
      ctx.moveTo(PADDING, y);
      ctx.lineTo(PADDING + GRAPH_WIDTH, y);
      ctx.stroke();
    }
  };

  const drawAxes = (ctx: CanvasRenderingContext2D) => {
    ctx.strokeStyle = "#9ca3af"; // gray-400
    ctx.fillStyle = "#374151"; // gray-700

    // X-axis
    ctx.beginPath();
    ctx.moveTo(PADDING, PADDING + GRAPH_HEIGHT);
    ctx.lineTo(PADDING + GRAPH_WIDTH, PADDING + GRAPH_HEIGHT);
    ctx.stroke();

    // Y-axis
    ctx.beginPath();
    ctx.moveTo(PADDING, PADDING);
    ctx.lineTo(PADDING, PADDING + GRAPH_HEIGHT);
    ctx.stroke();

    // X-axis labels
    for (let i = 0; i <= 10; i++) {
      const x = PADDING + (GRAPH_WIDTH * i) / 10;
      const label = ((maxTime * i) / 10).toFixed(0);
      ctx.fillText(label, x - 10, PADDING + GRAPH_HEIGHT + 20);
    }
    ctx.fillText("Time (min)", PADDING + GRAPH_WIDTH / 2 - 30, CANVAS_HEIGHT - 5);

    // Y-axis labels
    for (let i = 0; i <= 10; i++) {
      const y = PADDING + GRAPH_HEIGHT - (GRAPH_HEIGHT * i) / 10;
      const label = ((maxValue * i) / 10).toFixed(0);
      ctx.fillText(label, 5, y + 4);
    }
    ctx.save();
    ctx.translate(15, PADDING + GRAPH_HEIGHT / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("MeterValue (kWh)", -40, 0);
    ctx.restore();
  };

  const drawCurve = (ctx: CanvasRenderingContext2D) => {
    const sortedPoints = [...config.curvePoints].sort(
      (a, b) => a.time - b.time
    );

    ctx.strokeStyle = "#3b82f6"; // blue-500
    ctx.lineWidth = 2;
    ctx.beginPath();

    // Draw bezier curve with many segments
    const segments = 100;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const value = calculateBezierPoint(t, sortedPoints);
      const time =
        sortedPoints[0].time +
        (sortedPoints[sortedPoints.length - 1].time - sortedPoints[0].time) * t;

      const x = PADDING + (time / maxTime) * GRAPH_WIDTH;
      const y = PADDING + GRAPH_HEIGHT - (value / maxValue) * GRAPH_HEIGHT;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.lineWidth = 1;
  };

  const drawControlPoints = (ctx: CanvasRenderingContext2D) => {
    config.curvePoints.forEach((point, index) => {
      const x = PADDING + (point.time / maxTime) * GRAPH_WIDTH;
      const y = PADDING + GRAPH_HEIGHT - (point.value / maxValue) * GRAPH_HEIGHT;

      // Draw point
      ctx.fillStyle =
        index === selectedPointIndex ? "#ef4444" : "#10b981"; // red-500 or green-500
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 2 * Math.PI);
      ctx.fill();

      // Draw outline
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;

      // Draw label
      ctx.fillStyle = "#374151";
      ctx.fillText(
        `(${point.time.toFixed(1)}, ${point.value.toFixed(1)})`,
        x + 10,
        y - 10
      );
    });
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking on existing point
    const clickedPointIndex = config.curvePoints.findIndex((point) => {
      const px = PADDING + (point.time / maxTime) * GRAPH_WIDTH;
      const py = PADDING + GRAPH_HEIGHT - (point.value / maxValue) * GRAPH_HEIGHT;
      const distance = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      return distance < 10;
    });

    if (clickedPointIndex >= 0) {
      setSelectedPointIndex(clickedPointIndex);
    } else {
      // Add new point
      const time = ((x - PADDING) / GRAPH_WIDTH) * maxTime;
      const value = ((PADDING + GRAPH_HEIGHT - y) / GRAPH_HEIGHT) * maxValue;

      if (time >= 0 && time <= maxTime && value >= 0 && value <= maxValue) {
        setConfig({
          ...config,
          curvePoints: [...config.curvePoints, { time, value }].sort(
            (a, b) => a.time - b.time
          ),
        });
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (selectedPointIndex === null) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const time = Math.max(
      0,
      Math.min(maxTime, ((x - PADDING) / GRAPH_WIDTH) * maxTime)
    );
    const value = Math.max(
      0,
      Math.min(maxValue, ((PADDING + GRAPH_HEIGHT - y) / GRAPH_HEIGHT) * maxValue)
    );

    const newPoints = [...config.curvePoints];
    newPoints[selectedPointIndex] = { time, value };

    setConfig({
      ...config,
      curvePoints: newPoints.sort((a, b) => a.time - b.time),
    });
  };

  const handleCanvasMouseUp = () => {
    setSelectedPointIndex(null);
  };

  const handleDeletePoint = (index: number) => {
    if (config.curvePoints.length <= 2) {
      alert("Must have at least 2 control points");
      return;
    }

    setConfig({
      ...config,
      curvePoints: config.curvePoints.filter((_, i) => i !== index),
    });
    setSelectedPointIndex(null);
  };

  const handleAddPoint = () => {
    const newTime = maxTime / 2;
    const newValue = maxValue / 2;

    setConfig({
      ...config,
      curvePoints: [...config.curvePoints, { time: newTime, value: newValue }].sort(
        (a, b) => a.time - b.time
      ),
    });
  };

  const handleUpdatePoint = (
    index: number,
    field: "time" | "value",
    value: number
  ) => {
    const newPoints = [...config.curvePoints];
    newPoints[index] = { ...newPoints[index], [field]: value };

    setConfig({
      ...config,
      curvePoints: newPoints.sort((a, b) => a.time - b.time),
    });
  };

  const handleSave = () => {
    onSave(config);
    onClose();
  };

  const handleLoadPreset = (preset: "linear" | "exponential" | "step") => {
    let newPoints: CurvePoint[] = [];

    switch (preset) {
      case "linear":
        newPoints = [
          { time: 0, value: 0 },
          { time: maxTime, value: maxValue },
        ];
        break;
      case "exponential":
        newPoints = [
          { time: 0, value: 0 },
          { time: maxTime * 0.3, value: maxValue * 0.1 },
          { time: maxTime * 0.6, value: maxValue * 0.4 },
          { time: maxTime, value: maxValue },
        ];
        break;
      case "step":
        newPoints = [
          { time: 0, value: 0 },
          { time: maxTime * 0.5, value: 0 },
          { time: maxTime * 0.5, value: maxValue },
          { time: maxTime, value: maxValue },
        ];
        break;
    }

    setConfig({ ...config, curvePoints: newPoints });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="!z-[10000]" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] !z-[10001] grid w-full max-w-6xl translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg max-h-[90vh] overflow-y-auto"
          )}
        >
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        <DialogHeader>
          <DialogTitle>Configure Auto MeterValue</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Enable/Disable */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="autoEnabled"
              checked={config.enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, enabled: checked as boolean })
              }
            />
            <Label htmlFor="autoEnabled">Enable Auto MeterValue</Label>
          </div>

          {/* Canvas */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-white dark:bg-gray-900">
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              className="cursor-crosshair bg-white rounded"
              style={{ display: 'block', margin: '0 auto' }}
            />
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-2 text-center">
              Click to add control points, drag to move them
            </p>
          </div>

          {/* Axis Range Controls */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="maxTime">Max Time (minutes)</Label>
              <Input
                id="maxTime"
                type="number"
                value={maxTime}
                onChange={(e) => setMaxTime(Number(e.target.value))}
                min={1}
              />
            </div>
            <div>
              <Label htmlFor="maxValue">Max Value (kWh)</Label>
              <Input
                id="maxValue"
                type="number"
                value={maxValue}
                onChange={(e) => setMaxValue(Number(e.target.value))}
                min={1}
              />
            </div>
          </div>

          {/* Presets */}
          <div>
            <Label>Presets</Label>
            <div className="flex gap-2 mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleLoadPreset("linear")}
              >
                Linear
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleLoadPreset("exponential")}
              >
                Exponential
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleLoadPreset("step")}
              >
                Step
              </Button>
            </div>
          </div>

          {/* Interval Settings */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="intervalSeconds">Send Interval (seconds)</Label>
              <Input
                id="intervalSeconds"
                type="number"
                value={config.intervalSeconds}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    intervalSeconds: Number(e.target.value),
                  })
                }
                min={1}
                disabled={config.autoCalculateInterval}
              />
            </div>
            <div className="flex items-center gap-2 mt-6">
              <Checkbox
                id="autoCalculateInterval"
                checked={config.autoCalculateInterval}
                onCheckedChange={(checked) =>
                  setConfig({
                    ...config,
                    autoCalculateInterval: checked as boolean,
                  })
                }
              />
              <Label htmlFor="autoCalculateInterval">Auto Calculate</Label>
            </div>
          </div>

          {/* Control Points List */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Control Points</Label>
              <Button
                size="sm"
                variant="success"
                onClick={handleAddPoint}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Point
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2 bg-gray-50 dark:bg-gray-800">
              {config.curvePoints.map((point, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 mb-2 p-2 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600"
                >
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <div>
                      <Input
                        type="number"
                        value={point.time.toFixed(2)}
                        onChange={(e) =>
                          handleUpdatePoint(index, "time", Number(e.target.value))
                        }
                        className="text-xs"
                        step={0.1}
                      />
                      <span className="text-xs text-gray-600 dark:text-gray-400">min</span>
                    </div>
                    <div>
                      <Input
                        type="number"
                        value={point.value.toFixed(2)}
                        onChange={(e) =>
                          handleUpdatePoint(index, "value", Number(e.target.value))
                        }
                        className="text-xs"
                        step={0.1}
                      />
                      <span className="text-xs text-gray-600 dark:text-gray-400">kWh</span>
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDeletePoint(index)}
                    disabled={config.curvePoints.length <= 2}
                    className="text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            <X className="mr-2 h-5 w-5" />
            Cancel
          </Button>
          <Button onClick={handleSave}>
            <Save className="mr-2 h-5 w-5" />
            Save
          </Button>
        </DialogFooter>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

export default MeterValueCurveModal;
