// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Inbox } from "lucide-react";

import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import StatusPill from "./StatusPill";
import ModePill from "./ModePill";
import TargetChip from "./TargetChip";
import PageHeader from "./PageHeader";
import EmptyState from "./EmptyState";

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
  return container;
}

describe("StatusPill", () => {
  it("renders the label and emerald classes for Available", () => {
    const container = render(<StatusPill status={OCPPStatus.Available} />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.textContent).toContain("Available");
    expect(pill.className).toContain("bg-emerald-100");
    expect(pill.className).toContain("text-emerald-700");
    expect(pill.className).toContain("dark:bg-emerald-950");
    expect(pill.className).toContain("dark:text-emerald-300");
    expect(pill.className).toContain("rounded-full");
  });

  it("renders rose classes for Faulted", () => {
    const container = render(<StatusPill status={OCPPStatus.Faulted} />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.textContent).toContain("Faulted");
    expect(pill.className).toContain("bg-rose-100");
    expect(pill.className).toContain("text-rose-700");
    expect(pill.className).toContain("dark:bg-rose-950");
  });

  it("maps Charging to blue and SuspendedEV to amber", () => {
    const charging = render(<StatusPill status={OCPPStatus.Charging} />)
      .firstElementChild as HTMLElement;
    expect(charging.className).toContain("bg-blue-100");
    expect(charging.className).toContain("text-blue-700");
  });

  it("treats the string statuses Connected (emerald) and Disconnected (gray)", () => {
    const connected = render(<StatusPill status="Connected" />)
      .firstElementChild as HTMLElement;
    expect(connected.textContent).toContain("Connected");
    expect(connected.className).toContain("bg-emerald-100");

    const disconnected = render(<StatusPill status="Disconnected" />)
      .firstElementChild as HTMLElement;
    expect(disconnected.textContent).toContain("Disconnected");
    expect(disconnected.className).toContain("bg-gray-100");
    expect(disconnected.className).toContain("text-gray-700");
  });

  it("merges an extra className", () => {
    const pill = render(<StatusPill status="Connected" className="ml-2" />)
      .firstElementChild as HTMLElement;
    expect(pill.className).toContain("ml-2");
  });
});

describe("ModePill", () => {
  it("renders Remote mode / Local mode labels", () => {
    expect(
      (render(<ModePill mode="remote" />).firstElementChild as HTMLElement)
        .textContent,
    ).toContain("Remote mode");
    expect(
      (render(<ModePill mode="local" />).firstElementChild as HTMLElement)
        .textContent,
    ).toContain("Local mode");
  });
});

describe("TargetChip", () => {
  it("renders `CP-1 · C2` when a connector id is given", () => {
    const chip = render(<TargetChip cpId="CP-1" connectorId={2} />)
      .firstElementChild as HTMLElement;
    expect(chip.textContent).toBe("CP-1 · C2");
    expect(chip.className).toContain("font-mono");
  });

  it("renders just the cpId when connectorId is absent or null", () => {
    expect(
      (render(<TargetChip cpId="CP-1" />).firstElementChild as HTMLElement)
        .textContent,
    ).toBe("CP-1");
    expect(
      (
        render(<TargetChip cpId="CP-1" connectorId={null} />)
          .firstElementChild as HTMLElement
      ).textContent,
    ).toBe("CP-1");
  });
});

describe("PageHeader", () => {
  it("renders the title, count and actions", () => {
    const container = render(
      <PageHeader
        title="Charge Points"
        count="4 registered · 2 connected"
        actions={<button type="button">Add</button>}
      />,
    );
    expect(container.textContent).toContain("Charge Points");
    expect(container.textContent).toContain("4 registered · 2 connected");
    expect(container.querySelector("button")?.textContent).toBe("Add");
  });
});

describe("EmptyState", () => {
  it("renders title and hint, and an optional icon + action", () => {
    const container = render(
      <EmptyState
        icon={Inbox}
        title="No charge points"
        hint="Add one to get started"
        action={<button type="button">Add Charge Point</button>}
      />,
    );
    expect(container.textContent).toContain("No charge points");
    expect(container.textContent).toContain("Add one to get started");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("button")?.textContent).toBe(
      "Add Charge Point",
    );
  });
});
