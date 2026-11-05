// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ManualDisconnectButtons from "../ManualDisconnectButtons";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ManualDisconnectButtons", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("renders nothing when manualRuleIds is empty", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={[]}
          isConnected={true}
          onTriggerDisconnect={vi.fn()}
        />,
      );
    });

    expect(div.innerHTML).toBe("");
  });

  it("renders one button per manual rule ID", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={["rule-1", "rule-2"]}
          isConnected={true}
          onTriggerDisconnect={vi.fn()}
        />,
      );
    });

    const buttons = div.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("Force disconnect: rule-1");
    expect(buttons[1].textContent).toContain("Force disconnect: rule-2");
  });

  it("disables buttons when CP is not connected", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={["rule-1"]}
          isConnected={false}
          onTriggerDisconnect={vi.fn()}
        />,
      );
    });

    const button = div.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Charge point is not connected");
  });

  it("calls onTriggerDisconnect when button is clicked", async () => {
    const onTriggerDisconnect = vi.fn(async () => ({ ok: true }) as const);
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={["rule-1"]}
          isConnected={true}
          onTriggerDisconnect={onTriggerDisconnect}
        />,
      );
    });

    const button = div.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flush();

    expect(onTriggerDisconnect).toHaveBeenCalledWith("rule-1");
  });

  it("surfaces error when onTriggerDisconnect returns error", async () => {
    const onTriggerDisconnect = vi.fn(
      async () => ({ ok: false, error: "rule_not_manual" }) as const,
    );
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={["rule-1"]}
          isConnected={true}
          onTriggerDisconnect={onTriggerDisconnect}
        />,
      );
    });

    const button = div.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flush();

    expect(div.textContent).toContain("rule_not_manual");
  });

  it("guards against double-clicks with pending state", async () => {
    const onTriggerDisconnect = vi.fn(async () => {
      // Simulate a slow response
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true } as const;
    });
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <ManualDisconnectButtons
          manualRuleIds={["rule-1"]}
          isConnected={true}
          onTriggerDisconnect={onTriggerDisconnect}
        />,
      );
    });

    const button = div.querySelector("button") as HTMLButtonElement;

    // Click the button
    await act(async () => {
      button.click();
    });

    // Button should show pending state
    expect(button.textContent).toContain("Triggering…");
    expect(button.disabled).toBe(true);

    // Clicking again should not call the function again
    await act(async () => {
      button.click();
    });

    // Wait for the async operation to complete
    await new Promise((resolve) => setTimeout(resolve, 150));
    await flush();

    // Should only have been called once
    expect(onTriggerDisconnect).toHaveBeenCalledTimes(1);
  });
});
