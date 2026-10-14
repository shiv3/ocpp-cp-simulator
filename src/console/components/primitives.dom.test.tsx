// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Inbox } from "lucide-react";

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
