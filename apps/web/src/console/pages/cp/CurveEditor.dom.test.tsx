// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CURVE_VIEW, curveScale } from "./connectorCardModel";
import CurveEditor from "./CurveEditor";
import type { PowerPoint } from "./powerCurve";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

const RAMP: PowerPoint[] = [
  { minute: 0, kw: 0 },
  { minute: 3, kw: 7.4 },
  { minute: 50, kw: 7.4 },
  { minute: 60, kw: 0 },
];

async function renderEditor(initial: PowerPoint[] = RAMP, capKw = 11) {
  const changes = vi.fn();
  const latest: { points: PowerPoint[] } = { points: initial };
  const Host: React.FC = () => {
    const [points, setPoints] = useState(initial);
    latest.points = points;
    return (
      <CurveEditor
        points={points}
        capKw={capKw}
        intervalSeconds={10}
        capacityKwh={75}
        onChange={(next) => {
          changes(next);
          setPoints(next);
        }}
      />
    );
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Host />));
  const svg = container.querySelector<SVGSVGElement>(
    'svg[data-testid="curve-svg"]',
  )!;
  // jsdom lays nothing out: one client pixel per viewBox unit.
  svg.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: CURVE_VIEW.width,
      height: CURVE_VIEW.height,
    }) as DOMRect;
  return { container, svg, changes, latest };
}

function pointer(
  target: Element,
  type: string,
  clientX = 0,
  clientY = 0,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      button: 0,
    }),
  );
}

async function drag(svg: SVGSVGElement, index: number, x: number, y: number) {
  const circle = svg.querySelector(`[data-point-index="${index}"]`)!;
  await act(async () => pointer(circle, "pointerdown"));
  await act(async () => pointer(svg, "pointermove", x, y));
  await act(async () => pointer(svg, "pointerup", x, y));
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

describe("CurveEditor: power over the session, points you drag", () => {
  it("draws one handle per point, the cap line and the axis", async () => {
    const { container, svg } = await renderEditor();
    expect(svg.querySelectorAll("[data-point-index]")).toHaveLength(4);
    expect(svg.querySelector('[data-testid="curve-cap"]')).not.toBeNull();
    expect(svg.textContent).toContain("EV max 11 kW");
    expect(svg.textContent).toContain("60 min");
    expect(container.querySelectorAll("tbody tr[data-point-row]")).toHaveLength(
      4,
    );
  });

  it("drags a point, kept between its neighbours and under the EV's max power", async () => {
    const { svg, latest } = await renderEditor();

    // Far right and above the chart: stops at the next point and at the cap.
    await drag(svg, 1, CURVE_VIEW.width + 100, -50);
    expect(latest.points[1]).toEqual({ minute: 50, kw: 11 });

    // Far left and below: stops at the previous point and at 0 kW.
    await drag(svg, 1, -100, CURVE_VIEW.height + 100);
    expect(latest.points[1]).toEqual({ minute: 0, kw: 0 });

    // Inside the chart: minute to the integer, kW to 0.1.
    const { xMax, yMax } = curveScale(latest.points, 11);
    const { left, right, top, bottom, width, height } = CURVE_VIEW;
    const x = left + (20 / xMax) * (width - left - right);
    const y = top + (1 - 5 / yMax) * (height - top - bottom);
    await drag(svg, 1, x, y);
    expect(latest.points[1]).toEqual({ minute: 20, kw: 5 });
    // The neighbours did not move.
    expect(latest.points[0]).toEqual(RAMP[0]);
    expect(latest.points[2]).toEqual(RAMP[2]);
  });

  it("adds a point between the last two and removes one", async () => {
    const { container, latest } = await renderEditor();
    const add = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "+ Add point",
    )!;
    await act(async () => add.click());
    expect(latest.points).toHaveLength(5);
    expect(latest.points[3]).toEqual({ minute: 55, kw: 3.7 });

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove point 2"]',
    )!;
    await act(async () => remove.click());
    expect(latest.points.map((p) => p.minute)).toEqual([0, 50, 55, 60]);
  });

  it("keeps at least two points", async () => {
    const { container } = await renderEditor([
      { minute: 0, kw: 7 },
      { minute: 30, kw: 7 },
    ]);
    expect(
      container.querySelector('button[aria-label^="Remove point"]'),
    ).toBeNull();
  });

  it("edits a point in the table, within the same bounds", async () => {
    const { container, latest } = await renderEditor();
    const kw = container.querySelector<HTMLInputElement>(
      'input[aria-label="Point 3 kW"]',
    )!;
    await act(async () => typeInto(kw, "6.5"));
    expect(latest.points[2]).toEqual({ minute: 50, kw: 6.5 });

    const minute = container.querySelector<HTMLInputElement>(
      'input[aria-label="Point 3 minute"]',
    )!;
    await act(async () => typeInto(minute, "90"));
    expect(latest.points[2].minute).toBe(60);

    // A committed cell is drawn afresh: query it again.
    await act(async () =>
      typeInto(
        container.querySelector<HTMLInputElement>(
          'input[aria-label="Point 3 kW"]',
        )!,
        "40",
      ),
    );
    expect(latest.points[2].kw).toBe(11);
  });

  it("sums the curve up", async () => {
    const { container } = await renderEditor();
    const summary = container.querySelector('[data-testid="curve-summary"]');
    expect(summary?.textContent).toContain("Duration 60 min");
    expect(summary?.textContent).toContain(
      "Energy over the curve 6.6 kWh (9 % of the battery)",
    );
    expect(summary?.textContent).toContain("Peak 7.4 kW");
    expect(summary?.textContent).toContain("360 MeterValues at 10 s");
  });
});
