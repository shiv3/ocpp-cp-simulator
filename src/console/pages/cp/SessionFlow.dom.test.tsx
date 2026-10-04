// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import SessionFlow, { type SessionFlowProps } from "./SessionFlow";

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

async function renderFlow(props: Partial<SessionFlowProps> = {}) {
  const handlers = {
    onPlugIn: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onUnplug: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SessionFlow
        status={OCPPStatus.Available}
        transactionId={null}
        transactionTagId={null}
        tagIds={["TAG001", "TAG002"]}
        pending={false}
        {...handlers}
        {...props}
      />,
    ),
  );
  return { container, ...handlers };
}

const steps = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("[data-step]"));
const next = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-state="next"]');
const stepStates = (container: HTMLElement) =>
  steps(container).map((s) => s.dataset.state);

describe("SessionFlow: the charging session as a stepper", () => {
  it("lists the four steps with no numbers", async () => {
    const { container } = await renderFlow();
    expect(steps(container).map((s) => s.textContent?.trim())).toEqual([
      "▶Plug in",
      "Start charging",
      "Stop charging",
      "Unplug",
    ]);
    expect(
      container.querySelector('[role="group"]')?.getAttribute("aria-label"),
    ).toBe("Charging session");
  });

  it.each([
    [OCPPStatus.Available, null, "Plug in", ["next", "todo", "todo", "todo"]],
    [
      OCPPStatus.Preparing,
      null,
      "Start charging",
      ["done", "next", "todo", "todo"],
    ],
    [
      OCPPStatus.Charging,
      12,
      "Stop charging",
      ["done", "done", "next", "todo"],
    ],
    [
      OCPPStatus.SuspendedEV,
      12,
      "Stop charging",
      ["done", "done", "next", "todo"],
    ],
    [
      OCPPStatus.SuspendedEVSE,
      12,
      "Stop charging",
      ["done", "done", "next", "todo"],
    ],
    [OCPPStatus.Finishing, null, "Unplug", ["done", "done", "done", "next"]],
  ] as const)(
    "%s (tx %s): the next step is %s",
    async (status, transactionId, label, states) => {
      const { container } = await renderFlow({ status, transactionId });
      expect(next(container)?.textContent).toContain(label);
      expect(next(container)?.disabled).toBe(false);
      expect(stepStates(container)).toEqual(states);
      // Only the next step is a live button.
      expect(steps(container).filter((s) => !s.disabled)).toHaveLength(1);
    },
  );

  it("marks done steps with a check", async () => {
    const { container } = await renderFlow({
      status: OCPPStatus.Charging,
      transactionId: 3,
    });
    expect(steps(container)[0].textContent).toContain("✓");
    expect(steps(container)[1].textContent).toContain("✓");
    expect(next(container)?.textContent).toContain("▶");
  });

  it("Plug in, Stop and Unplug call their handlers", async () => {
    const plug = await renderFlow();
    await act(async () => next(plug.container)!.click());
    expect(plug.onPlugIn).toHaveBeenCalledTimes(1);

    await act(async () => root!.unmount());
    root = null;
    const stop = await renderFlow({
      status: OCPPStatus.Charging,
      transactionId: 9,
      transactionTagId: "TAG002",
    });
    expect(stop.container.textContent).toContain("Tx #9 · TAG002");
    await act(async () => next(stop.container)!.click());
    expect(stop.onStop).toHaveBeenCalledTimes(1);

    await act(async () => root!.unmount());
    root = null;
    const unplug = await renderFlow({ status: OCPPStatus.Finishing });
    await act(async () => next(unplug.container)!.click());
    expect(unplug.onUnplug).toHaveBeenCalledTimes(1);
  });

  it("Start passes the tag picked beside it", async () => {
    const { container, onStart } = await renderFlow({
      status: OCPPStatus.Preparing,
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="TagID of the transaction"]',
    )!;
    expect(select.value).toBe("TAG001");
    await act(async () => {
      select.value = "TAG002";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => next(container)!.click());
    expect(onStart).toHaveBeenCalledWith("TAG002");
  });

  it("cannot start without a TagID", async () => {
    const { container } = await renderFlow({
      status: OCPPStatus.Preparing,
      tagIds: [],
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="TagID of the transaction"]',
    )!;
    expect(select.disabled).toBe(true);
    expect(select.textContent).toContain("No TagIDs configured");
    expect(next(container)?.disabled).toBe(true);
  });

  it("Faulted with a transaction reads Charging (faulted), with nothing primary", async () => {
    const { container } = await renderFlow({
      status: OCPPStatus.Faulted,
      transactionId: 4,
    });
    expect(next(container)).toBeNull();
    const current = container.querySelector('[data-state="current"]');
    expect(current?.textContent).toContain("Charging (faulted)");
    expect(steps(container).every((s) => s.disabled)).toBe(true);
  });

  it("Unavailable disables every step and says how to get out", async () => {
    const { container } = await renderFlow({ status: OCPPStatus.Unavailable });
    expect(steps(container).every((s) => s.disabled)).toBe(true);
    expect(next(container)).toBeNull();
    expect(container.textContent).toContain(
      "Unavailable: send Available in Controls to plug in",
    );
  });

  it("disables the next step while an action is pending", async () => {
    const { container } = await renderFlow({ pending: true });
    expect(steps(container).every((s) => s.disabled)).toBe(true);
  });
});
