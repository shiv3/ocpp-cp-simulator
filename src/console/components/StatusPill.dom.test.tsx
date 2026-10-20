// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import StatusPill from "./StatusPill";
import { statusDotClass } from "./statusColor";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let mounted: Root | null = null;

afterEach(() => {
  if (mounted) {
    const root = mounted;
    act(() => {
      root.unmount();
    });
    mounted = null;
  }
  document.body.innerHTML = "";
});

function render(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = root;
  act(() => {
    root.render(ui);
  });
  return container.firstElementChild as HTMLElement;
}

describe("StatusPill", () => {
  it("renders a colored dot and the plain status text, with no fill", () => {
    const pill = render(<StatusPill status={OCPPStatus.Available} />);
    const dot = pill.firstElementChild as HTMLElement;
    expect(pill.textContent).toBe("Available");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.className).toContain("bg-cx-emerald");
    expect(pill.className).not.toMatch(/\bbg-|rounded-full/);
  });

  it.each([
    [OCPPStatus.Charging, "bg-cx-blue"],
    [OCPPStatus.Preparing, "bg-cx-amber"],
    [OCPPStatus.SuspendedEVSE, "bg-cx-amber"],
    [OCPPStatus.Faulted, "bg-cx-rose"],
    [OCPPStatus.Unavailable, "bg-cx-rose"],
    ["Connected" as const, "bg-cx-emerald"],
  ])("maps %s to %s", (status, dotClass) => {
    const pill = render(<StatusPill status={status} />);
    expect((pill.firstElementChild as HTMLElement).className).toContain(
      dotClass,
    );
    expect(statusDotClass(status)).toBe(dotClass);
  });

  it("uses the gray dot and muted text for Disconnected", () => {
    const pill = render(<StatusPill status="Disconnected" />);
    expect(pill.textContent).toBe("Disconnected");
    expect((pill.firstElementChild as HTMLElement).className).toContain(
      "bg-cx-gray",
    );
    expect(pill.className).toContain("text-cx-muted");
  });

  it("merges an extra className", () => {
    expect(
      render(<StatusPill status="Connected" className="ml-2" />).className,
    ).toContain("ml-2");
  });
});
