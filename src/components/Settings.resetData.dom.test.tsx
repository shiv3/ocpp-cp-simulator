// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import Settings from "./Settings";

/**
 * #374: the reset handler caught with a bare `catch {}` and then read `err`,
 * so a failed reset threw a ReferenceError out of the handler and the page
 * showed the generic "Reset failed" instead of the runtime's reason.
 */

const resetAllState = vi.fn<() => Promise<void>>();

vi.mock("../data/providers/DataProvider", () => ({
  useDataContext: () => ({
    mode: "remote",
    serverUrl: "http://test",
    defaultEvSettings: null,
    setDefaultEvSettings: vi.fn(),
    chargePointService: {
      loadConfig: vi.fn(async () => null),
      subscribeConfig: vi.fn(() => () => {}),
      resetAllState,
    },
  }),
}));

describe("Settings reset all simulator data", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows why the reset failed", async () => {
    resetAllState.mockRejectedValue(new Error("database is locked"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });

    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset all simulator data"),
    );
    if (!button) throw new Error("No reset button");
    await act(async () => {
      button.click();
    });

    expect(resetAllState).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("database is locked");
    await act(async () => {
      root.unmount();
    });
  });
});
